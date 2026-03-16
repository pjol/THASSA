package format

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/pjol/THASSA/node/internal/shape"
)

type CallbackFormatter interface {
	EncodeCallbackData(fields []shape.FieldSpec, shaped map[string]any) ([]byte, error)
}

type ABIFormatter struct{}

func NewABIFormatter() ABIFormatter {
	return ABIFormatter{}
}

func (f ABIFormatter) EncodeCallbackData(fields []shape.FieldSpec, shaped map[string]any) ([]byte, error) {
	if err := shape.ValidateFields(fields); err != nil {
		return nil, err
	}

	if shaped == nil {
		return nil, fmt.Errorf("shaped output is empty")
	}

	args := make(abi.Arguments, 0, len(fields))
	values := make([]any, 0, len(fields))

	for _, field := range fields {
		argType, err := abi.NewType(field.SolidityType, "", nil)
		if err != nil {
			return nil, fmt.Errorf("invalid solidity type %q: %w", field.SolidityType, err)
		}

		rawValue, exists := shaped[field.Name]
		coercedValue, err := coerceValue(rawValue, argType, !exists && field.Optional)
		if err != nil {
			return nil, fmt.Errorf("field %q (%s): %w", field.Name, field.SolidityType, err)
		}

		args = append(args, abi.Argument{Name: field.Name, Type: argType})
		values = append(values, coercedValue)
	}

	return args.Pack(values...)
}

func coerceValue(raw any, argType abi.Type, useZero bool) (any, error) {
	if useZero {
		return zeroValueForType(argType)
	}

	if raw == nil {
		return nil, fmt.Errorf("missing value")
	}

	switch argType.T {
	case abi.StringTy:
		value, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("expected string")
		}
		return value, nil
	case abi.BoolTy:
		return parseBool(raw)
	case abi.AddressTy:
		value, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("expected address string")
		}
		if !common.IsHexAddress(value) {
			return nil, fmt.Errorf("invalid address %q", value)
		}
		return common.HexToAddress(value), nil
	case abi.BytesTy:
		return parseBytes(raw)
	case abi.FixedBytesTy:
		bytesValue, err := parseBytes(raw)
		if err != nil {
			return nil, err
		}
		if len(bytesValue) != argType.Size {
			return nil, fmt.Errorf("expected %d bytes, got %d", argType.Size, len(bytesValue))
		}
		arr := reflect.New(argType.GetType()).Elem()
		for i := 0; i < len(bytesValue); i++ {
			arr.Index(i).SetUint(uint64(bytesValue[i]))
		}
		return arr.Interface(), nil
	case abi.UintTy:
		number, err := toBigInt(raw)
		if err != nil {
			return nil, err
		}
		return castUnsigned(number, argType.Size)
	case abi.IntTy:
		number, err := toBigInt(raw)
		if err != nil {
			return nil, err
		}
		return castSigned(number, argType.Size)
	default:
		return nil, fmt.Errorf("unsupported ABI type: %s", argType.String())
	}
}

func parseBool(raw any) (bool, error) {
	switch value := raw.(type) {
	case bool:
		return value, nil
	case string:
		switch strings.ToLower(value) {
		case "true":
			return true, nil
		case "false":
			return false, nil
		default:
			return false, fmt.Errorf("expected boolean string")
		}
	default:
		return false, fmt.Errorf("expected boolean")
	}
}

func parseBytes(raw any) ([]byte, error) {
	switch value := raw.(type) {
	case string:
		if strings.HasPrefix(value, "0x") || strings.HasPrefix(value, "0X") {
			decoded, err := hex.DecodeString(value[2:])
			if err != nil {
				return nil, fmt.Errorf("invalid hex bytes: %w", err)
			}
			return decoded, nil
		}
		return []byte(value), nil
	case []byte:
		return value, nil
	default:
		return nil, fmt.Errorf("expected byte string")
	}
}

func toBigInt(raw any) (*big.Int, error) {
	switch value := raw.(type) {
	case json.Number:
		n := new(big.Int)
		if _, ok := n.SetString(value.String(), 10); !ok {
			return nil, fmt.Errorf("invalid json number %q", value.String())
		}
		return n, nil
	case string:
		n := new(big.Int)
		if _, ok := n.SetString(value, 0); !ok {
			return nil, fmt.Errorf("invalid number string %q", value)
		}
		return n, nil
	case float64:
		if math.Trunc(value) != value {
			return nil, fmt.Errorf("expected integer value")
		}
		return big.NewInt(int64(value)), nil
	case float32:
		if math.Trunc(float64(value)) != float64(value) {
			return nil, fmt.Errorf("expected integer value")
		}
		return big.NewInt(int64(value)), nil
	case int:
		return big.NewInt(int64(value)), nil
	case int8:
		return big.NewInt(int64(value)), nil
	case int16:
		return big.NewInt(int64(value)), nil
	case int32:
		return big.NewInt(int64(value)), nil
	case int64:
		return big.NewInt(value), nil
	case uint:
		return new(big.Int).SetUint64(uint64(value)), nil
	case uint8:
		return new(big.Int).SetUint64(uint64(value)), nil
	case uint16:
		return new(big.Int).SetUint64(uint64(value)), nil
	case uint32:
		return new(big.Int).SetUint64(uint64(value)), nil
	case uint64:
		return new(big.Int).SetUint64(value), nil
	case *big.Int:
		if value == nil {
			return nil, fmt.Errorf("number is nil")
		}
		return new(big.Int).Set(value), nil
	default:
		return nil, fmt.Errorf("expected integer-compatible value")
	}
}

func castUnsigned(value *big.Int, bits int) (any, error) {
	if value.Sign() < 0 {
		return nil, fmt.Errorf("uint cannot be negative")
	}
	if bits > 0 && value.BitLen() > bits {
		return nil, fmt.Errorf("value overflows uint%d", bits)
	}

	switch {
	case bits <= 8:
		return uint8(value.Uint64()), nil
	case bits <= 16:
		return uint16(value.Uint64()), nil
	case bits <= 32:
		return uint32(value.Uint64()), nil
	case bits <= 64:
		return value.Uint64(), nil
	default:
		return value, nil
	}
}

func castSigned(value *big.Int, bits int) (any, error) {
	min, max := signedBounds(bits)
	if value.Cmp(min) < 0 || value.Cmp(max) > 0 {
		return nil, fmt.Errorf("value overflows int%d", bits)
	}

	switch {
	case bits <= 8:
		return int8(value.Int64()), nil
	case bits <= 16:
		return int16(value.Int64()), nil
	case bits <= 32:
		return int32(value.Int64()), nil
	case bits <= 64:
		return value.Int64(), nil
	default:
		return value, nil
	}
}

func signedBounds(bits int) (*big.Int, *big.Int) {
	if bits <= 0 {
		bits = 256
	}

	one := big.NewInt(1)
	max := new(big.Int).Lsh(one, uint(bits-1))
	max.Sub(max, one)

	min := new(big.Int).Lsh(one, uint(bits-1))
	min.Neg(min)

	return min, max
}

func zeroValueForType(argType abi.Type) (any, error) {
	switch argType.T {
	case abi.StringTy:
		return "", nil
	case abi.BoolTy:
		return false, nil
	case abi.AddressTy:
		return common.Address{}, nil
	case abi.BytesTy:
		return []byte{}, nil
	case abi.FixedBytesTy:
		arr := reflect.New(argType.GetType()).Elem()
		return arr.Interface(), nil
	case abi.UintTy:
		return castUnsigned(big.NewInt(0), argType.Size)
	case abi.IntTy:
		return castSigned(big.NewInt(0), argType.Size)
	default:
		return nil, fmt.Errorf("unsupported optional ABI type: %s", argType.String())
	}
}
