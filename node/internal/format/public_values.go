package format

import (
	"fmt"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

func EncodeFulfillmentPublicValues(fulfilled bool) ([]byte, error) {
	boolType, err := abi.NewType("bool", "", nil)
	if err != nil {
		return nil, fmt.Errorf("create bool ABI type: %w", err)
	}

	return abi.Arguments{{Type: boolType}}.Pack(fulfilled)
}
