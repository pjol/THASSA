global MAX_FIELDS: u32 = 16;
global MAX_FIELD_NAME_BYTES: u32 = 64;
global MAX_FIELD_TYPE_BYTES: u32 = 16;
global MAX_DYNAMIC_BYTES: u32 = 256;
global MAX_CALLBACK_BYTES: u32 = 1024;
global MAX_SHAPE_BYTES: u32 = 1024;
global PREFIX_PUBLIC_INPUTS: u32 = 29;

global MAX_QUERY_BYTES: u32 = 2048;
global MAX_MODEL_BYTES: u32 = 64;
global MAX_INPUT_DATA_JSON_BYTES: u32 = 4096;
global MAX_OPENAI_BASE_URL_BYTES: u32 = 256;
global MAX_OPENAI_BASE_URL_CHUNKS: u32 = 9;
global MAX_OPENAI_ENDPOINT_BYTES: u32 = 128;
global MAX_OPENAI_ENDPOINT_CHUNKS: u32 = 5;
global MAX_RESPONSE_ID_BYTES: u32 = 66;
global MAX_RESPONSE_BODY_BYTES: u32 = 8192;
global MAX_STRUCTURED_OUTPUT_BYTES: u32 = 4096;
global MAX_REQUEST_CONTEXT_CHARS: u32 = 10000;

global MAX_REQUEST_URL_BYTES: u32 = 256;
global MAX_REQUEST_HEADER_BYTES: u32 = 1024;
global MAX_REQUEST_METHOD_BYTES: u32 = 8;
global MAX_REQUEST_BODY_BYTES: u32 = 8192;
global MAX_RESPONSE_KEY_NAME_BYTES: u32 = 66;
global MAX_RESPONSE_PARSE_TYPE_BYTES: u32 = 16;
global MAX_RESPONSE_PARSE_PATH_BYTES: u32 = 128;
global MAX_ATTESTATION_DATA_BYTES: u32 = 4096;
global MAX_ATT_CONDITIONS_BYTES: u32 = 2048;
global MAX_ADDITION_PARAMS_BYTES: u32 = 1024;

global MAX_REQUEST_PACKED_BYTES: u32 =
    MAX_REQUEST_URL_BYTES + MAX_REQUEST_HEADER_BYTES + MAX_REQUEST_METHOD_BYTES + MAX_REQUEST_BODY_BYTES;
global MAX_RESPONSE_PACKED_BYTES: u32 =
    MAX_RESPONSE_KEY_NAME_BYTES + MAX_RESPONSE_PARSE_TYPE_BYTES + MAX_RESPONSE_PARSE_PATH_BYTES;
global MAX_ATTESTATION_PACKED_BYTES: u32 =
    20 + 32 + 32 + MAX_ATTESTATION_DATA_BYTES + MAX_ATT_CONDITIONS_BYTES + 32 + MAX_ADDITION_PARAMS_BYTES;

global KECCAK_RATE_BYTES: u32 = 136;
global SHA256_BLOCK_BYTES: u32 = 64;
global MAX_RESPONSE_BODY_SHA256_BLOCKS: u32 = (MAX_RESPONSE_BODY_BYTES + 72) / SHA256_BLOCK_BYTES;

global FIELD_KIND_STATIC: u8 = 0;
global FIELD_KIND_DYNAMIC: u8 = 1;

global TYPE_KIND_STRING: u8 = 1;
global TYPE_KIND_BYTES: u8 = 2;
global TYPE_KIND_BOOL: u8 = 3;
global TYPE_KIND_ADDRESS: u8 = 4;
global TYPE_KIND_FIXED_BYTES: u8 = 5;
global TYPE_KIND_UINT: u8 = 6;
global TYPE_KIND_INT: u8 = 7;

global FULFILLMENT_INDEX: u32 = 0;
global CLIENT_INDEX: u32 = 6;
global FULFILLER_INDEX: u32 = 7;
global ATTESTOR_INDEX: u32 = 8;
global QUERY_HASH_HI_INDEX: u32 = 9;
global QUERY_HASH_LO_INDEX: u32 = 10;
global SHAPE_HASH_HI_INDEX: u32 = 11;
global SHAPE_HASH_LO_INDEX: u32 = 12;
global MODEL_HASH_HI_INDEX: u32 = 13;
global MODEL_HASH_LO_INDEX: u32 = 14;
global CLIENT_VERSION_INDEX: u32 = 15;
global REQUEST_TIMESTAMP_INDEX: u32 = 16;
global INPUT_DATA_HASH_HI_INDEX: u32 = 17;
global INPUT_DATA_HASH_LO_INDEX: u32 = 18;
global RESPONSE_ID_HI_INDEX: u32 = 19;
global RESPONSE_ID_LO_INDEX: u32 = 20;
global CALLBACK_HASH_HI_INDEX: u32 = 21;
global CALLBACK_HASH_LO_INDEX: u32 = 22;
global HUB_INDEX: u32 = 23;
global CHAIN_ID_INDEX: u32 = 24;
global URL_LEN_INDEX: u32 = 25;
global URL_CHUNK_COUNT_INDEX: u32 = 26;
global ENDPOINT_LEN_INDEX: u32 = 27;
global ENDPOINT_CHUNK_COUNT_INDEX: u32 = 28;

global UPDATE_TYPEHASH: [u8; 32] = [
    42, 207, 117, 219, 27, 6, 218, 10,
    239, 126, 236, 100, 95, 196, 199, 181,
    113, 208, 231, 148, 200, 73, 5, 58,
    249, 166, 94, 202, 60, 125, 186, 5
];

global KEY_MODEL: [u8; 5] = [109, 111, 100, 101, 108];
global KEY_MESSAGES: [u8; 8] = [109, 101, 115, 115, 97, 103, 101, 115];
global KEY_CONTENT: [u8; 7] = [99, 111, 110, 116, 101, 110, 116];
global KEY_ROLE: [u8; 4] = [114, 111, 108, 101];
global KEY_WEB_SEARCH_OPTIONS: [u8; 18] = [119, 101, 98, 95, 115, 101, 97, 114, 99, 104, 95, 111, 112, 116, 105, 111, 110, 115];
global KEY_SEARCH_CONTEXT_SIZE: [u8; 19] = [115, 101, 97, 114, 99, 104, 95, 99, 111, 110, 116, 101, 120, 116, 95, 115, 105, 122, 101];
global KEY_RESPONSE_FORMAT: [u8; 15] = [114, 101, 115, 112, 111, 110, 115, 101, 95, 102, 111, 114, 109, 97, 116];
global KEY_TYPE: [u8; 4] = [116, 121, 112, 101];
global KEY_JSON_SCHEMA: [u8; 11] = [106, 115, 111, 110, 95, 115, 99, 104, 101, 109, 97];
global KEY_NAME: [u8; 4] = [110, 97, 109, 101];
global KEY_STRICT: [u8; 6] = [115, 116, 114, 105, 99, 116];
global KEY_SCHEMA: [u8; 6] = [115, 99, 104, 101, 109, 97];
global KEY_CHOICES: [u8; 7] = [99, 104, 111, 105, 99, 101, 115];
global KEY_MESSAGE: [u8; 7] = [109, 101, 115, 115, 97, 103, 101];
global KEY_PROPERTIES: [u8; 10] = [112, 114, 111, 112, 101, 114, 116, 105, 101, 115];
global KEY_ADDITIONAL_PROPERTIES: [u8; 20] = [97, 100, 100, 105, 116, 105, 111, 110, 97, 108, 80, 114, 111, 112, 101, 114, 116, 105, 101, 115];
global KEY_REQUIRED: [u8; 8] = [114, 101, 113, 117, 105, 114, 101, 100];
global KEY_ACCEPT_ENCODING: [u8; 15] = [65, 99, 99, 101, 112, 116, 45, 69, 110, 99, 111, 100, 105, 110, 103];
global KEY_AUTHORIZATION: [u8; 13] = [65, 117, 116, 104, 111, 114, 105, 122, 97, 116, 105, 111, 110];
global KEY_CONTENT_TYPE: [u8; 12] = [67, 111, 110, 116, 101, 110, 116, 45, 84, 121, 112, 101];

global VALUE_POST: [u8; 4] = [80, 79, 83, 84];
global VALUE_JSON: [u8; 4] = [106, 115, 111, 110];
global VALUE_PARSE_PATH: [u8; 28] = [36, 46, 99, 104, 111, 105, 99, 101, 115, 91, 48, 93, 46, 109, 101, 115, 115, 97, 103, 101, 46, 99, 111, 110, 116, 101, 110, 116];
global VALUE_USER: [u8; 4] = [117, 115, 101, 114];
global VALUE_JSON_SCHEMA: [u8; 11] = [106, 115, 111, 110, 95, 115, 99, 104, 101, 109, 97];
global VALUE_THASSA_OUTPUT: [u8; 13] = [116, 104, 97, 115, 115, 97, 95, 111, 117, 116, 112, 117, 116];
global VALUE_OBJECT: [u8; 6] = [111, 98, 106, 101, 99, 116];
global VALUE_STRING: [u8; 6] = [115, 116, 114, 105, 110, 103];
global VALUE_IDENTITY: [u8; 8] = [105, 100, 101, 110, 116, 105, 116, 121];
global VALUE_APPLICATION_JSON: [u8; 16] = [97, 112, 112, 108, 105, 99, 97, 116, 105, 111, 110, 47, 106, 115, 111, 110];
global VALUE_BEARER_PREFIX: [u8; 7] = [66, 101, 97, 114, 101, 114, 32];
global VALUE_MEDIUM: [u8; 6] = [109, 101, 100, 105, 117, 109];
global VALUE_OPENAI_PREFIX: [u8; 7] = [111, 112, 101, 110, 97, 105, 58];

global PROMPT_QUERY_PREFIX: [u8; 7] = [81, 117, 101, 114, 121, 58, 10];
global PROMPT_INPUT_PREFIX: [u8; 21] = [10, 10, 73, 110, 112, 117, 116, 32, 100, 97, 116, 97, 32, 40, 74, 83, 79, 78, 41, 58, 10];
global PROMPT_OUTPUT_SUFFIX: [u8; 70] = [10, 10, 82, 101, 116, 117, 114, 110, 32, 111, 110, 108, 121, 32, 97, 32, 74, 83, 79, 78, 32, 111, 98, 106, 101, 99, 116, 32, 116, 104, 97, 116, 32, 115, 116, 114, 105, 99, 116, 108, 121, 32, 109, 97, 116, 99, 104, 101, 115, 32, 116, 104, 101, 32, 112, 114, 111, 118, 105, 100, 101, 100, 32, 115, 99, 104, 101, 109, 97, 46];

fn main(
    prefix_public_inputs: pub [Field; PREFIX_PUBLIC_INPUTS],
    url_chunks: pub [Field; MAX_OPENAI_BASE_URL_CHUNKS],
    endpoint_chunks: pub [Field; MAX_OPENAI_ENDPOINT_CHUNKS],
    hub_address: [u8; 20],
    chain_id: u64,
    client_address: [u8; 20],
    bid_id_word: [u8; 32],
    auto_flow: bool,
    client_version: u64,
    field_count: u32,
    field_name_lengths: [u32; MAX_FIELDS],
    field_names: [[u8; MAX_FIELD_NAME_BYTES]; MAX_FIELDS],
    field_type_lengths: [u32; MAX_FIELDS],
    field_types: [[u8; MAX_FIELD_TYPE_BYTES]; MAX_FIELDS],
    field_kinds: [u8; MAX_FIELDS],
    static_words: [[u8; 32]; MAX_FIELDS],
    dynamic_lengths: [u32; MAX_FIELDS],
    dynamic_bytes: [[u8; MAX_DYNAMIC_BYTES]; MAX_FIELDS],
    query_len: u32,
    query: [u8; MAX_QUERY_BYTES],
    model_len: u32,
    model: [u8; MAX_MODEL_BYTES],
    input_data_json_len: u32,
    input_data_json: [u8; MAX_INPUT_DATA_JSON_BYTES],
    openai_base_url_len: u32,
    openai_base_url: [u8; MAX_OPENAI_BASE_URL_BYTES],
    openai_endpoint_len: u32,
    openai_endpoint: [u8; MAX_OPENAI_ENDPOINT_BYTES],
    attestor_pubkey_x: [u8; 32],
    attestor_pubkey_y: [u8; 32],
    attestation_signature: [u8; 64],
    recipient_address: [u8; 20],
    attestation_timestamp_millis: u64,
    request_url_len: u32,
    request_url: [u8; MAX_REQUEST_URL_BYTES],
    request_header_len: u32,
    request_header: [u8; MAX_REQUEST_HEADER_BYTES],
    request_method_len: u32,
    request_method: [u8; MAX_REQUEST_METHOD_BYTES],
    request_body_len: u32,
    request_body: [u8; MAX_REQUEST_BODY_BYTES],
    response_key_name_len: u32,
    response_key_name: [u8; MAX_RESPONSE_KEY_NAME_BYTES],
    response_parse_type_len: u32,
    response_parse_type: [u8; MAX_RESPONSE_PARSE_TYPE_BYTES],
    response_parse_path_len: u32,
    response_parse_path: [u8; MAX_RESPONSE_PARSE_PATH_BYTES],
    attestation_data_len: u32,
    attestation_data: [u8; MAX_ATTESTATION_DATA_BYTES],
    att_conditions_len: u32,
    att_conditions: [u8; MAX_ATT_CONDITIONS_BYTES],
    addition_params_len: u32,
    addition_params: [u8; MAX_ADDITION_PARAMS_BYTES],
    response_id_len: u32,
    response_id: [u8; MAX_RESPONSE_ID_BYTES],
    response_body_len: u32,
    response_body: [u8; MAX_RESPONSE_BODY_BYTES],
) {
    assert(prefix_public_inputs[FULFILLMENT_INDEX] == 1);
    assert(field_count > 0);
    assert(field_count <= MAX_FIELDS);

    assert(prefix_public_inputs[CLIENT_INDEX] == address_bytes_to_field(client_address));
    assert(prefix_public_inputs[HUB_INDEX] == address_bytes_to_field(hub_address));
    assert(prefix_public_inputs[CHAIN_ID_INDEX] == chain_id as Field);
    assert(prefix_public_inputs[CLIENT_VERSION_INDEX] == client_version as Field);
    assert(prefix_public_inputs[5] == if auto_flow { 1 as Field } else { 0 as Field });
    let (bid_id_hi, bid_id_lo) = bytes32_to_fields(bid_id_word);
    assert(prefix_public_inputs[3] == bid_id_hi);
    assert(prefix_public_inputs[4] == bid_id_lo);

    let request_timestamp_secs = attestation_timestamp_millis / 1000;
    assert(prefix_public_inputs[REQUEST_TIMESTAMP_INDEX] == request_timestamp_secs as Field);

    let recipient_field = address_bytes_to_field(recipient_address);
    assert(prefix_public_inputs[FULFILLER_INDEX] == recipient_field);

    let attestor_field = public_key_to_address(attestor_pubkey_x, attestor_pubkey_y);
    assert(prefix_public_inputs[ATTESTOR_INDEX] == attestor_field);

    let public_url_len = prefix_public_inputs[URL_LEN_INDEX] as u32;
    let public_url_chunk_count = prefix_public_inputs[URL_CHUNK_COUNT_INDEX] as u32;
    assert(public_url_len == openai_base_url_len);
    assert(public_url_chunk_count == expected_chunk_count(openai_base_url_len));
    assert_chunked_bytes(
        openai_base_url,
        openai_base_url_len,
        url_chunks,
        public_url_chunk_count,
    );

    let public_endpoint_len = prefix_public_inputs[ENDPOINT_LEN_INDEX] as u32;
    let public_endpoint_chunk_count = prefix_public_inputs[ENDPOINT_CHUNK_COUNT_INDEX] as u32;
    assert(public_endpoint_len == openai_endpoint_len);
    assert(public_endpoint_chunk_count == expected_chunk_count(openai_endpoint_len));
    assert_chunked_bytes(
        openai_endpoint,
        openai_endpoint_len,
        endpoint_chunks,
        public_endpoint_chunk_count,
    );

    let request_hash = request_hash(
        request_url_len,
        request_url,
        request_header_len,
        request_header,
        request_method_len,
        request_method,
        request_body_len,
        request_body,
    );
    let response_hash = response_hash(
        response_key_name_len,
        response_key_name,
        response_parse_type_len,
        response_parse_type,
        response_parse_path_len,
        response_parse_path,
    );
    let attestation_hash = attestation_hash(
        recipient_address,
        request_hash,
        response_hash,
        attestation_data_len,
        attestation_data,
        att_conditions_len,
        att_conditions,
        attestation_timestamp_millis,
        addition_params_len,
        addition_params,
    );

    let valid_signature = std::ecdsa_secp256k1::verify_signature(
        attestor_pubkey_x,
        attestor_pubkey_y,
        attestation_signature,
        attestation_hash,
    );
    assert(valid_signature);

    let mut expected_request_url = [0 as u8; MAX_REQUEST_URL_BYTES];
    let (next_url, next_cursor) =
        append_bytes(expected_request_url, 0, openai_base_url_len, openai_base_url);
    expected_request_url = next_url;
    let (expected_request_url, expected_request_url_len) = append_bytes(
        expected_request_url,
        next_cursor,
        openai_endpoint_len,
        openai_endpoint,
    );
    assert(matches_bytes(
        request_url,
        request_url_len,
        expected_request_url,
        expected_request_url_len,
    ));
    assert(matches_bytes(request_method, request_method_len, VALUE_POST, 4));
    assert(matches_bytes(response_key_name, response_key_name_len, response_id, response_id_len));
    assert(matches_bytes(response_parse_type, response_parse_type_len, VALUE_JSON, 4));
    assert(matches_bytes(response_parse_path, response_parse_path_len, VALUE_PARSE_PATH, 28));
    assert_request_header_mask(request_header, request_header_len);

    let mut shape = [0 as u8; MAX_SHAPE_BYTES];
    let mut shape_len = 0;
    shape[0] = 116;
    shape[1] = 117;
    shape[2] = 112;
    shape[3] = 108;
    shape[4] = 101;
    shape[5] = 40;
    shape_len = 6;

    for i in 0..MAX_FIELDS {
        if i < field_count {
            assert(field_name_lengths[i] > 0);
            assert(field_type_lengths[i] > 0);
            if i > 0 {
                shape[shape_len] = 44;
                shape_len += 1;
            }
            for j in 0..MAX_FIELD_NAME_BYTES {
                if j < field_name_lengths[i] {
                    shape[shape_len] = field_names[i][j];
                    shape_len += 1;
                }
            }
            shape[shape_len] = 58;
            shape_len += 1;
            for j in 0..MAX_FIELD_TYPE_BYTES {
                if j < field_type_lengths[i] {
                    shape[shape_len] = field_types[i][j];
                    shape_len += 1;
                }
            }
        } else {
            assert(field_name_lengths[i] == 0);
            assert(field_type_lengths[i] == 0);
            assert(dynamic_lengths[i] == 0);
        }
    }
    shape[shape_len] = 41;
    shape_len += 1;

    assert_hash_matches_public(prefix_public_inputs, SHAPE_HASH_HI_INDEX, SHAPE_HASH_LO_INDEX, shape, shape_len);
    assert_hash_matches_public(prefix_public_inputs, QUERY_HASH_HI_INDEX, QUERY_HASH_LO_INDEX, query, query_len);
    assert_hash_matches_public(prefix_public_inputs, MODEL_HASH_HI_INDEX, MODEL_HASH_LO_INDEX, model, model_len);
    assert_hash_matches_public(
        prefix_public_inputs,
        INPUT_DATA_HASH_HI_INDEX,
        INPUT_DATA_HASH_LO_INDEX,
        input_data_json,
        input_data_json_len,
    );

    let request_object_start = skip_ws(request_body, request_body_len, 0);
    assert(request_body[request_object_start] == 123);
    assert(count_object_entries(request_body, request_body_len, request_object_start) == 4);

    let (model_start, _, model_found) = find_object_value_range(
        request_body,
        request_body_len,
        request_object_start,
        5,
        KEY_MODEL,
    );
    assert(model_found);
    let (request_model, request_model_len, _) =
        parse_json_string_at::<MAX_REQUEST_BODY_BYTES, MAX_MODEL_BYTES>(
            request_body,
            request_body_len,
            model_start,
        );
    assert(matches_openai_model_from_spec(request_model, request_model_len, model, model_len));

    let (messages_start, _, messages_found) = find_object_value_range(
        request_body,
        request_body_len,
        request_object_start,
        8,
        KEY_MESSAGES,
    );
    assert(messages_found);
    assert(count_array_entries(request_body, request_body_len, messages_start) == 1);
    let (user_message_start, _, user_message_found) =
        find_array_element_range(request_body, request_body_len, messages_start, 0);
    assert(user_message_found);
    assert(count_object_entries(request_body, request_body_len, user_message_start) == 2);
    let (role_start, _, role_found) = find_object_value_range(
        request_body,
        request_body_len,
        user_message_start,
        4,
        KEY_ROLE,
    );
    assert(role_found);
    let (role_value, role_len, _) =
        parse_json_string_at::<MAX_REQUEST_BODY_BYTES, 8>(request_body, request_body_len, role_start);
    assert(matches_bytes(role_value, role_len, VALUE_USER, 4));
    let (user_content_start, _, user_content_found) = find_object_value_range(
        request_body,
        request_body_len,
        user_message_start,
        7,
        KEY_CONTENT,
    );
    assert(user_content_found);
    let (user_prompt, user_prompt_len, _) =
        parse_json_string_at::<MAX_REQUEST_BODY_BYTES, MAX_INPUT_DATA_JSON_BYTES + MAX_QUERY_BYTES + 128>(
            request_body,
            request_body_len,
            user_content_start,
        );
    assert(matches_prompt_exact(
        user_prompt,
        user_prompt_len,
        query,
        query_len,
        input_data_json,
        input_data_json_len,
    ));

    let (web_search_options_start, _, web_search_options_found) = find_object_value_range(
        request_body,
        request_body_len,
        request_object_start,
        18,
        KEY_WEB_SEARCH_OPTIONS,
    );
    assert(web_search_options_found);
    assert(count_object_entries(request_body, request_body_len, web_search_options_start) == 1);
    let (search_context_size_start, _, search_context_size_found) = find_object_value_range(
        request_body,
        request_body_len,
        web_search_options_start,
        19,
        KEY_SEARCH_CONTEXT_SIZE,
    );
    assert(search_context_size_found);
    let (search_context_size, search_context_size_len, _) =
        parse_json_string_at::<MAX_REQUEST_BODY_BYTES, 16>(
            request_body,
            request_body_len,
            search_context_size_start,
        );
    assert(matches_bytes(search_context_size, search_context_size_len, VALUE_MEDIUM, 6));

    let (response_format_start, _, response_format_found) = find_object_value_range(
        request_body,
        request_body_len,
        request_object_start,
        15,
        KEY_RESPONSE_FORMAT,
    );
    assert(response_format_found);
    assert(count_object_entries(request_body, request_body_len, response_format_start) == 2);
    let (response_format_type_start, _, response_format_type_found) = find_object_value_range(
        request_body,
        request_body_len,
        response_format_start,
        4,
        KEY_TYPE,
    );
    assert(response_format_type_found);
    let (response_format_type, response_format_type_len, _) =
        parse_json_string_at::<MAX_REQUEST_BODY_BYTES, 16>(
            request_body,
            request_body_len,
            response_format_type_start,
        );
    assert(matches_bytes(response_format_type, response_format_type_len, VALUE_JSON_SCHEMA, 11));

    let (json_schema_start, _, json_schema_found) = find_object_value_range(
        request_body,
        request_body_len,
        response_format_start,
        11,
        KEY_JSON_SCHEMA,
    );
    assert(json_schema_found);
    assert(count_object_entries(request_body, request_body_len, json_schema_start) == 3);
    let (json_schema_name_start, _, json_schema_name_found) = find_object_value_range(
        request_body,
        request_body_len,
        json_schema_start,
        4,
        KEY_NAME,
    );
    assert(json_schema_name_found);
    let (json_schema_name, json_schema_name_len, _) =
        parse_json_string_at::<MAX_REQUEST_BODY_BYTES, 16>(
            request_body,
            request_body_len,
            json_schema_name_start,
        );
    assert(matches_bytes(json_schema_name, json_schema_name_len, VALUE_THASSA_OUTPUT, 13));
    let (strict_start, strict_end, strict_found) = find_object_value_range(
        request_body,
        request_body_len,
        json_schema_start,
        6,
        KEY_STRICT,
    );
    assert(strict_found);
    assert(parse_bool_range(request_body, request_body_len, strict_start, strict_end));
    let (schema_start, schema_end, schema_found) = find_object_value_range(
        request_body,
        request_body_len,
        json_schema_start,
        6,
        KEY_SCHEMA,
    );
    assert(schema_found);
    let context_chars = query_len + input_data_json_len + (schema_end - schema_start);
    assert(context_chars <= MAX_REQUEST_CONTEXT_CHARS);
    assert_schema_matches_fields(
        request_body,
        request_body_len,
        schema_start,
        field_count,
        field_name_lengths,
        field_names,
        field_type_lengths,
        field_types,
    );

    let response_id_bytes32 = hex_string_to_bytes32(response_id, response_id_len);
    let (response_id_hi, response_id_lo) = bytes32_to_fields(response_id_bytes32);
    assert(prefix_public_inputs[RESPONSE_ID_HI_INDEX] == response_id_hi);
    assert(prefix_public_inputs[RESPONSE_ID_LO_INDEX] == response_id_lo);

    let committed_response_hash = lookup_attestation_hash(
        attestation_data,
        attestation_data_len,
        response_id,
        response_id_len,
    );
    let response_body_hash = sha256_var::<MAX_RESPONSE_BODY_BYTES, MAX_RESPONSE_BODY_SHA256_BLOCKS>(
        response_body,
        response_body_len,
    );
    assert(bytes_equal(committed_response_hash, 32, response_body_hash, 32));

    let (structured_output, structured_output_len) =
        extract_openai_message_content(response_body, response_body_len);
    let structured_object_start = skip_ws(structured_output, structured_output_len, 0);
    assert(structured_output[structured_object_start] == 123);
    assert(count_object_entries(structured_output, structured_output_len, structured_object_start) == field_count);

    for i in 0..MAX_FIELDS {
        if i < field_count {
            let (type_kind, type_param) =
                parse_solidity_type(field_types[i], field_type_lengths[i]);
            if type_kind == TYPE_KIND_STRING {
                assert(field_kinds[i] == FIELD_KIND_DYNAMIC);
                let (value_start, value_end, found) = find_object_value_range(
                    structured_output,
                    structured_output_len,
                    structured_object_start,
                    field_name_lengths[i],
                    field_names[i],
                );
                assert(found);
                let (value, value_len, _) =
                    parse_json_string_at::<MAX_STRUCTURED_OUTPUT_BYTES, MAX_DYNAMIC_BYTES>(
                        structured_output,
                        structured_output_len,
                        value_start,
                    );
                assert(dynamic_lengths[i] == value_len);
                assert(bytes_equal(dynamic_bytes[i], value_len, value, value_len));
                assert(static_words[i] == [0 as u8; 32]);
                assert(value_end > value_start);
            } else if type_kind == TYPE_KIND_BYTES {
                assert(field_kinds[i] == FIELD_KIND_DYNAMIC);
                let (value_start, value_end, found) = find_object_value_range(
                    structured_output,
                    structured_output_len,
                    structured_object_start,
                    field_name_lengths[i],
                    field_names[i],
                );
                assert(found);
                let (string_value, string_value_len, _) =
                    parse_json_string_at::<MAX_STRUCTURED_OUTPUT_BYTES, MAX_DYNAMIC_BYTES * 2 + 2>(
                        structured_output,
                        structured_output_len,
                        value_start,
                    );
                let (decoded_value, decoded_len) = decode_bytes_string(string_value, string_value_len);
                assert(dynamic_lengths[i] == decoded_len);
                assert(bytes_equal(dynamic_bytes[i], decoded_len, decoded_value, decoded_len));
                assert(static_words[i] == [0 as u8; 32]);
                assert(value_end > value_start);
            } else if type_kind == TYPE_KIND_BOOL {
                assert(field_kinds[i] == FIELD_KIND_STATIC);
                let (value_start, value_end, found) = find_object_value_range(
                    structured_output,
                    structured_output_len,
                    structured_object_start,
                    field_name_lengths[i],
                    field_names[i],
                );
                assert(found);
                let expected_word = bool_to_word(
                    parse_bool_value(structured_output, structured_output_len, value_start, value_end),
                );
                assert(static_words[i] == expected_word);
                assert(dynamic_lengths[i] == 0);
            } else if type_kind == TYPE_KIND_ADDRESS {
                assert(field_kinds[i] == FIELD_KIND_STATIC);
                let (value_start, _, found) = find_object_value_range(
                    structured_output,
                    structured_output_len,
                    structured_object_start,
                    field_name_lengths[i],
                    field_names[i],
                );
                assert(found);
                let (string_value, string_value_len, _) =
                    parse_json_string_at::<MAX_STRUCTURED_OUTPUT_BYTES, 64>(
                        structured_output,
                        structured_output_len,
                        value_start,
                    );
                let address_word = address_string_to_word(string_value, string_value_len);
                assert(static_words[i] == address_word);
                assert(dynamic_lengths[i] == 0);
            } else if type_kind == TYPE_KIND_FIXED_BYTES {
                assert(field_kinds[i] == FIELD_KIND_STATIC);
                let (value_start, _, found) = find_object_value_range(
                    structured_output,
                    structured_output_len,
                    structured_object_start,
                    field_name_lengths[i],
                    field_names[i],
                );
                assert(found);
                let (string_value, string_value_len, _) =
                    parse_json_string_at::<MAX_STRUCTURED_OUTPUT_BYTES, 128>(
                        structured_output,
                        structured_output_len,
                        value_start,
                    );
                let (decoded_value, decoded_len) = decode_bytes_string(string_value, string_value_len);
                assert(decoded_len == type_param);
                let expected_word = fixed_bytes_to_word(decoded_value, decoded_len);
                assert(static_words[i] == expected_word);
                assert(dynamic_lengths[i] == 0);
            } else if type_kind == TYPE_KIND_UINT {
                assert(field_kinds[i] == FIELD_KIND_STATIC);
                let (value_start, value_end, found) = find_object_value_range(
                    structured_output,
                    structured_output_len,
                    structured_object_start,
                    field_name_lengths[i],
                    field_names[i],
                );
                assert(found);
                let expected_word = parse_uint_word(
                    structured_output,
                    structured_output_len,
                    value_start,
                    value_end,
                    type_param,
                );
                assert(static_words[i] == expected_word);
                assert(dynamic_lengths[i] == 0);
            } else {
                assert(type_kind == TYPE_KIND_INT);
                assert(field_kinds[i] == FIELD_KIND_STATIC);
                let (value_start, value_end, found) = find_object_value_range(
                    structured_output,
                    structured_output_len,
                    structured_object_start,
                    field_name_lengths[i],
                    field_names[i],
                );
                assert(found);
                let expected_word = parse_int_word(
                    structured_output,
                    structured_output_len,
                    value_start,
                    value_end,
                    type_param,
                );
                assert(static_words[i] == expected_word);
                assert(dynamic_lengths[i] == 0);
            }
        }
    }

    let mut callback = [0 as u8; MAX_CALLBACK_BYTES];
    let head_size = field_count * 32;
    assert(head_size <= MAX_CALLBACK_BYTES);

    let mut tail_cursor = head_size;

    for i in 0..MAX_FIELDS {
        if i < field_count {
            let head_offset = i * 32;

            if field_kinds[i] == FIELD_KIND_STATIC {
                for j in 0..32 {
                    callback[head_offset + j] = static_words[i][j];
                }
            } else {
                assert(field_kinds[i] == FIELD_KIND_DYNAMIC);
                assert(dynamic_lengths[i] <= MAX_DYNAMIC_BYTES);

                let offset_word = u32_to_abi_word(tail_cursor);
                for j in 0..32 {
                    callback[head_offset + j] = offset_word[j];
                }

                let length_word = u32_to_abi_word(dynamic_lengths[i]);
                for j in 0..32 {
                    callback[tail_cursor + j] = length_word[j];
                }

                let data_offset = tail_cursor + 32;
                for j in 0..MAX_DYNAMIC_BYTES {
                    if j < dynamic_lengths[i] {
                        callback[data_offset + j] = dynamic_bytes[i][j];
                    }
                }

                tail_cursor = tail_cursor + 32 + padded_len(dynamic_lengths[i]);
                assert(tail_cursor <= MAX_CALLBACK_BYTES);
            }
        }
    }

    let callback_hash = keccak256_var(callback, tail_cursor);
    let (callback_hash_hi, callback_hash_lo) = bytes32_to_fields(callback_hash);
    assert(prefix_public_inputs[CALLBACK_HASH_HI_INDEX] == callback_hash_hi);
    assert(prefix_public_inputs[CALLBACK_HASH_LO_INDEX] == callback_hash_lo);

    let query_hash_for_digest = keccak256_var(query, query_len);
    let shape_hash_for_digest = keccak256_var(shape, shape_len);
    let model_hash_for_digest = keccak256_var(model, model_len);
    let input_hash_for_digest = keccak256_var(input_data_json, input_data_json_len);
    let digest = hub_update_digest(
        hub_address,
        chain_id,
        client_address,
        bid_id_word,
        auto_flow,
        callback_hash,
        input_hash_for_digest,
        response_id_bytes32,
        query_hash_for_digest,
        shape_hash_for_digest,
        model_hash_for_digest,
        client_version,
        request_timestamp_secs,
        recipient_address,
    );
    let (digest_hi, digest_lo) = bytes32_to_fields(digest);
    assert(prefix_public_inputs[1] == digest_hi);
    assert(prefix_public_inputs[2] == digest_lo);
}

fn assert_request_header_mask(
    request_header: [u8; MAX_REQUEST_HEADER_BYTES],
    request_header_len: u32,
) {
    let header_object_start = skip_ws(request_header, request_header_len, 0);
    assert(request_header[header_object_start] == 123);
    assert(count_object_entries(request_header, request_header_len, header_object_start) == 3);

    let (accept_start, _, accept_found) = find_object_value_range(
        request_header,
        request_header_len,
        header_object_start,
        15,
        KEY_ACCEPT_ENCODING,
    );
    assert(accept_found);
    let (accept_value, accept_len, _) =
        parse_json_string_at::<MAX_REQUEST_HEADER_BYTES, 16>(request_header, request_header_len, accept_start);
    assert(matches_bytes(accept_value, accept_len, VALUE_IDENTITY, 8));

    let (content_type_start, _, content_type_found) = find_object_value_range(
        request_header,
        request_header_len,
        header_object_start,
        12,
        KEY_CONTENT_TYPE,
    );
    assert(content_type_found);
    let (content_type_value, content_type_len, _) =
        parse_json_string_at::<MAX_REQUEST_HEADER_BYTES, 32>(
            request_header,
            request_header_len,
            content_type_start,
        );
    assert(matches_bytes(content_type_value, content_type_len, VALUE_APPLICATION_JSON, 16));

    let (authorization_start, _, authorization_found) = find_object_value_range(
        request_header,
        request_header_len,
        header_object_start,
        13,
        KEY_AUTHORIZATION,
    );
    assert(authorization_found);
    let (authorization_value, authorization_len, _) =
        parse_json_string_at::<MAX_REQUEST_HEADER_BYTES, MAX_REQUEST_HEADER_BYTES>(
            request_header,
            request_header_len,
            authorization_start,
        );
    assert(authorization_len > 7);
    assert(slice_matches_at(authorization_value, authorization_len, 0, VALUE_BEARER_PREFIX, 7));
}

fn assert_schema_matches_fields(
    request_body: [u8; MAX_REQUEST_BODY_BYTES],
    request_body_len: u32,
    schema_start: u32,
    field_count: u32,
    field_name_lengths: [u32; MAX_FIELDS],
    field_names: [[u8; MAX_FIELD_NAME_BYTES]; MAX_FIELDS],
    field_type_lengths: [u32; MAX_FIELDS],
    field_types: [[u8; MAX_FIELD_TYPE_BYTES]; MAX_FIELDS],
) {
    assert(count_object_entries(request_body, request_body_len, schema_start) == 4);
    let (schema_type_start, _, schema_type_found) = find_object_value_range(
        request_body,
        request_body_len,
        schema_start,
        4,
        KEY_TYPE,
    );
    assert(schema_type_found);
    let (schema_type_value, schema_type_len, _) =
        parse_json_string_at::<MAX_REQUEST_BODY_BYTES, 16>(request_body, request_body_len, schema_type_start);
    assert(matches_bytes(schema_type_value, schema_type_len, VALUE_OBJECT, 6));

    let (additional_start, additional_end, additional_found) = find_object_value_range(
        request_body,
        request_body_len,
        schema_start,
        20,
        KEY_ADDITIONAL_PROPERTIES,
    );
    assert(additional_found);
    assert(!parse_bool_value(request_body, request_body_len, additional_start, additional_end));

    let (properties_start, _, properties_found) = find_object_value_range(
        request_body,
        request_body_len,
        schema_start,
        10,
        KEY_PROPERTIES,
    );
    assert(properties_found);
    assert(count_object_entries(request_body, request_body_len, properties_start) == field_count);

    let (required_start, _, required_found) = find_object_value_range(
        request_body,
        request_body_len,
        schema_start,
        8,
        KEY_REQUIRED,
    );
    assert(required_found);
    assert(count_array_entries(request_body, request_body_len, required_start) == field_count);

    for i in 0..MAX_FIELDS {
        if i < field_count {
            let (property_start, _, property_found) = find_object_value_range(
                request_body,
                request_body_len,
                properties_start,
                field_name_lengths[i],
                field_names[i],
            );
            assert(property_found);
            assert(count_object_entries(request_body, request_body_len, property_start) == 1);
            let (property_type_start, _, property_type_found) = find_object_value_range(
                request_body,
                request_body_len,
                property_start,
                4,
                KEY_TYPE,
            );
            assert(property_type_found);
            let (property_type_value, property_type_len, _) =
                parse_json_string_at::<MAX_REQUEST_BODY_BYTES, 16>(
                    request_body,
                    request_body_len,
                    property_type_start,
                );
            let (json_type, json_type_len) =
                expected_json_type(field_types[i], field_type_lengths[i]);
            assert(matches_bytes(property_type_value, property_type_len, json_type, json_type_len));

            let (required_value_start, _, required_found_for_index) =
                find_array_element_range(request_body, request_body_len, required_start, i);
            assert(required_found_for_index);
            let (required_name, required_name_len, _) =
                parse_json_string_at::<MAX_REQUEST_BODY_BYTES, MAX_FIELD_NAME_BYTES>(
                    request_body,
                    request_body_len,
                    required_value_start,
                );
            assert(matches_bytes(required_name, required_name_len, field_names[i], field_name_lengths[i]));
        }
    }
}

fn matches_openai_model_from_spec(
    request_model: [u8; MAX_MODEL_BYTES],
    request_model_len: u32,
    model_spec: [u8; MAX_MODEL_BYTES],
    model_spec_len: u32,
) -> bool {
    let spec_start = trim_ascii_start(model_spec, model_spec_len);
    let spec_end = trim_ascii_end(model_spec, model_spec_len);
    let mut matches = false;
    if spec_end >= spec_start {
        let mut model_start = spec_start;
        let mut model_len = spec_end - spec_start;
        if (model_len >= 7) & slice_matches_at(model_spec, model_spec_len, spec_start, VALUE_OPENAI_PREFIX, 7) {
            model_start = spec_start + 7;
            model_len -= 7;
        }
        matches = matches_model_slice(request_model, request_model_len, model_spec, model_start, model_len);
    }
    matches
}

fn trim_ascii_start(bytes: [u8; MAX_MODEL_BYTES], len: u32) -> u32 {
    let mut start = 0;
    let mut done = false;
    for i in 0..MAX_MODEL_BYTES {
        if !done {
            if i < len {
                if is_whitespace(bytes[i]) {
                    start = i + 1;
                } else {
                    done = true;
                }
            }
        }
    }
    start
}

fn trim_ascii_end(bytes: [u8; MAX_MODEL_BYTES], len: u32) -> u32 {
    let mut end = len;
    let mut done = false;
    for offset in 0..MAX_MODEL_BYTES {
        if !done {
            if offset < len {
                let idx = len - 1 - offset;
                if is_whitespace(bytes[idx]) {
                    end = idx;
                } else {
                    done = true;
                }
            }
        }
    }
    end
}

fn matches_model_slice(
    value: [u8; MAX_MODEL_BYTES],
    value_len: u32,
    source: [u8; MAX_MODEL_BYTES],
    source_start: u32,
    source_len: u32,
) -> bool {
    let mut equal = value_len == source_len;
    if equal {
        assert(source_start + source_len <= MAX_MODEL_BYTES);
        for i in 0..MAX_MODEL_BYTES {
            if i < value_len {
                if value[i] != source[source_start + i] {
                    equal = false;
                }
            }
        }
    }
    equal
}

fn expected_json_type(
    field_type: [u8; MAX_FIELD_TYPE_BYTES],
    field_type_len: u32,
) -> ([u8; 8], u32) {
    let (type_kind, _) = parse_solidity_type(field_type, field_type_len);
    if type_kind == TYPE_KIND_BOOL {
        ([98, 111, 111, 108, 101, 97, 110, 0], 7)
    } else if type_kind == TYPE_KIND_UINT {
        ([105, 110, 116, 101, 103, 101, 114, 0], 7)
    } else if type_kind == TYPE_KIND_INT {
        ([105, 110, 116, 101, 103, 101, 114, 0], 7)
    } else {
        ([115, 116, 114, 105, 110, 103, 0, 0], 6)
    }
}

fn matches_prompt_exact(
    prompt: [u8; MAX_INPUT_DATA_JSON_BYTES + MAX_QUERY_BYTES + 128],
    prompt_len: u32,
    query: [u8; MAX_QUERY_BYTES],
    query_len: u32,
    input_data_json: [u8; MAX_INPUT_DATA_JSON_BYTES],
    input_data_json_len: u32,
) -> bool {
    let mut idx = 0;
    let mut matches = true;
    if !slice_matches_at(prompt, prompt_len, idx, PROMPT_QUERY_PREFIX, 7) {
        matches = false;
    }
    idx += 7;
    if !slice_matches_at(prompt, prompt_len, idx, query, query_len) {
        matches = false;
    }
    idx += query_len;
    if !slice_matches_at(prompt, prompt_len, idx, PROMPT_INPUT_PREFIX, 21) {
        matches = false;
    }
    idx += 21;
    if !slice_matches_at(prompt, prompt_len, idx, input_data_json, input_data_json_len) {
        matches = false;
    }
    idx += input_data_json_len;
    if !slice_matches_at(prompt, prompt_len, idx, PROMPT_OUTPUT_SUFFIX, 70) {
        matches = false;
    }
    idx += 70;
    matches & (idx == prompt_len)
}

fn extract_openai_message_content(
    response_body: [u8; MAX_RESPONSE_BODY_BYTES],
    response_body_len: u32,
) -> ([u8; MAX_STRUCTURED_OUTPUT_BYTES], u32) {
    let response_object_start = skip_ws(response_body, response_body_len, 0);
    assert(response_body[response_object_start] == 123);

    let (choices_start, _, choices_found) = find_object_value_range(
        response_body,
        response_body_len,
        response_object_start,
        7,
        KEY_CHOICES,
    );
    assert(choices_found);
    let (first_choice_start, _, first_choice_found) =
        find_array_element_range(response_body, response_body_len, choices_start, 0);
    assert(first_choice_found);

    let (message_start, _, message_found) = find_object_value_range(
        response_body,
        response_body_len,
        first_choice_start,
        7,
        KEY_MESSAGE,
    );
    assert(message_found);
    let (content_start, _, content_found) = find_object_value_range(
        response_body,
        response_body_len,
        message_start,
        7,
        KEY_CONTENT,
    );
    assert(content_found);

    let (content, content_len, _) =
        parse_json_string_at::<MAX_RESPONSE_BODY_BYTES, MAX_STRUCTURED_OUTPUT_BYTES>(
            response_body,
            response_body_len,
            content_start,
        );
    (content, content_len)
}

fn lookup_attestation_hash(
    attestation_data: [u8; MAX_ATTESTATION_DATA_BYTES],
    attestation_data_len: u32,
    response_id: [u8; MAX_RESPONSE_ID_BYTES],
    response_id_len: u32,
) -> [u8; 32] {
    let attestation_object_start = skip_ws(attestation_data, attestation_data_len, 0);
    assert(attestation_data[attestation_object_start] == 123);
    let (hash_start, _, found) = find_object_value_range(
        attestation_data,
        attestation_data_len,
        attestation_object_start,
        response_id_len,
        response_id,
    );
    assert(found);
    let (hash_string, hash_string_len, _) =
        parse_json_string_at::<MAX_ATTESTATION_DATA_BYTES, 66>(
            attestation_data,
            attestation_data_len,
            hash_start,
        );
    hex_string_to_bytes32(hash_string, hash_string_len)
}

fn request_hash(
    request_url_len: u32,
    request_url: [u8; MAX_REQUEST_URL_BYTES],
    request_header_len: u32,
    request_header: [u8; MAX_REQUEST_HEADER_BYTES],
    request_method_len: u32,
    request_method: [u8; MAX_REQUEST_METHOD_BYTES],
    request_body_len: u32,
    request_body: [u8; MAX_REQUEST_BODY_BYTES],
) -> [u8; 32] {
    let mut packed = [0 as u8; MAX_REQUEST_PACKED_BYTES];
    let mut cursor = 0;
    let (next, next_cursor) = append_bytes(packed, cursor, request_url_len, request_url);
    packed = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(packed, cursor, request_header_len, request_header);
    packed = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(packed, cursor, request_method_len, request_method);
    packed = next;
    cursor = next_cursor;
    let (packed, cursor) = append_bytes(packed, cursor, request_body_len, request_body);
    keccak256_var(packed, cursor)
}

fn response_hash(
    response_key_name_len: u32,
    response_key_name: [u8; MAX_RESPONSE_KEY_NAME_BYTES],
    response_parse_type_len: u32,
    response_parse_type: [u8; MAX_RESPONSE_PARSE_TYPE_BYTES],
    response_parse_path_len: u32,
    response_parse_path: [u8; MAX_RESPONSE_PARSE_PATH_BYTES],
) -> [u8; 32] {
    let mut packed = [0 as u8; MAX_RESPONSE_PACKED_BYTES];
    let mut cursor = 0;
    let (next, next_cursor) = append_bytes(packed, cursor, response_key_name_len, response_key_name);
    packed = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(packed, cursor, response_parse_type_len, response_parse_type);
    packed = next;
    cursor = next_cursor;
    let (packed, cursor) = append_bytes(packed, cursor, response_parse_path_len, response_parse_path);
    keccak256_var(packed, cursor)
}

fn attestation_hash(
    recipient_address: [u8; 20],
    request_hash: [u8; 32],
    response_hash: [u8; 32],
    attestation_data_len: u32,
    attestation_data: [u8; MAX_ATTESTATION_DATA_BYTES],
    att_conditions_len: u32,
    att_conditions: [u8; MAX_ATT_CONDITIONS_BYTES],
    attestation_timestamp_millis: u64,
    addition_params_len: u32,
    addition_params: [u8; MAX_ADDITION_PARAMS_BYTES],
) -> [u8; 32] {
    let mut packed = [0 as u8; MAX_ATTESTATION_PACKED_BYTES];
    let mut cursor = 0;
    let (next, next_cursor) = append_bytes(packed, cursor, 20, recipient_address);
    packed = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(packed, cursor, 32, request_hash);
    packed = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(packed, cursor, 32, response_hash);
    packed = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(packed, cursor, attestation_data_len, attestation_data);
    packed = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(packed, cursor, att_conditions_len, att_conditions);
    packed = next;
    cursor = next_cursor;
    let timestamp_word = u64_to_abi_word(attestation_timestamp_millis);
    let (next, next_cursor) = append_bytes(packed, cursor, 32, timestamp_word);
    packed = next;
    cursor = next_cursor;
    let (packed, cursor) = append_bytes(packed, cursor, addition_params_len, addition_params);
    keccak256_var(packed, cursor)
}

fn hub_update_digest(
    hub_address: [u8; 20],
    chain_id: u64,
    client_address: [u8; 20],
    bid_id_word: [u8; 32],
    auto_flow: bool,
    callback_hash: [u8; 32],
    input_data_hash: [u8; 32],
    response_id: [u8; 32],
    query_hash: [u8; 32],
    shape_hash: [u8; 32],
    model_hash: [u8; 32],
    client_version: u64,
    request_timestamp: u64,
    fulfiller_address: [u8; 20],
) -> [u8; 32] {
    let mut payload = [0 as u8; 320];
    let mut cursor = 0;
    let (next, next_cursor) = append_bytes(payload, cursor, 32, address_to_abi_word(client_address));
    payload = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(payload, cursor, 32, callback_hash);
    payload = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(payload, cursor, 32, input_data_hash);
    payload = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(payload, cursor, 32, response_id);
    payload = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(payload, cursor, 32, query_hash);
    payload = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(payload, cursor, 32, shape_hash);
    payload = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(payload, cursor, 32, model_hash);
    payload = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(payload, cursor, 32, u64_to_abi_word(client_version));
    payload = next;
    cursor = next_cursor;
    let (next, next_cursor) = append_bytes(payload, cursor, 32, u64_to_abi_word(request_timestamp));
    payload = next;
    cursor = next_cursor;
    let (payload, cursor) = append_bytes(payload, cursor, 32, address_to_abi_word(fulfiller_address));
    let payload_hash = keccak256_var(payload, cursor);

    let mut outer = [0 as u8; 192];
    let mut outer_cursor = 0;
    let (next_outer, next_outer_cursor) = append_bytes(outer, outer_cursor, 32, UPDATE_TYPEHASH);
    outer = next_outer;
    outer_cursor = next_outer_cursor;
    let (next_outer, next_outer_cursor) = append_bytes(outer, outer_cursor, 32, address_to_abi_word(hub_address));
    outer = next_outer;
    outer_cursor = next_outer_cursor;
    let (next_outer, next_outer_cursor) = append_bytes(outer, outer_cursor, 32, u64_to_abi_word(chain_id));
    outer = next_outer;
    outer_cursor = next_outer_cursor;
    let (next_outer, next_outer_cursor) = append_bytes(outer, outer_cursor, 32, payload_hash);
    outer = next_outer;
    outer_cursor = next_outer_cursor;
    let (next_outer, next_outer_cursor) = append_bytes(outer, outer_cursor, 32, bid_id_word);
    outer = next_outer;
    outer_cursor = next_outer_cursor;
    let (outer, outer_cursor) = append_bytes(outer, outer_cursor, 32, bool_to_abi_word(auto_flow));
    keccak256_var(outer, outer_cursor)
}

fn public_key_to_address(public_key_x: [u8; 32], public_key_y: [u8; 32]) -> Field {
    let mut encoded = [0 as u8; 64];
    for i in 0..32 {
        encoded[i] = public_key_x[i];
        encoded[32 + i] = public_key_y[i];
    }

    let hash = keccak256_var(encoded, 64);
    let mut address = 0 as Field;
    for i in 12..32 {
        address = address * 256 + hash[i] as Field;
    }
    address
}

fn parse_solidity_type(
    field_type: [u8; MAX_FIELD_TYPE_BYTES],
    field_type_len: u32,
) -> (u8, u32) {
    let mut type_kind = 0;
    let mut type_param = 0;
    let mut matched = false;

    if matches_ascii_insensitive(field_type, field_type_len, VALUE_STRING, 6) {
        type_kind = TYPE_KIND_STRING;
        matched = true;
    }
    if !matched {
        if matches_ascii_insensitive(field_type, field_type_len, [98, 121, 116, 101, 115], 5) {
            type_kind = TYPE_KIND_BYTES;
            matched = true;
        }
    }
    if !matched {
        if matches_ascii_insensitive(field_type, field_type_len, [98, 111, 111, 108], 4) {
            type_kind = TYPE_KIND_BOOL;
            matched = true;
        }
    }
    if !matched {
        if matches_ascii_insensitive(field_type, field_type_len, [97, 100, 100, 114, 101, 115, 115], 7) {
            type_kind = TYPE_KIND_ADDRESS;
            matched = true;
        }
    }
    if !matched {
        if (field_type_len >= 5)
            & (lower_ascii(field_type[0]) == 98)
            & (lower_ascii(field_type[1]) == 121)
            & (lower_ascii(field_type[2]) == 116)
            & (lower_ascii(field_type[3]) == 101)
            & (lower_ascii(field_type[4]) == 115)
        {
            if field_type_len == 5 {
                type_kind = TYPE_KIND_BYTES;
            } else {
                type_kind = TYPE_KIND_FIXED_BYTES;
                type_param = parse_decimal_ascii(field_type, 5, field_type_len);
                assert((type_param >= 1) & (type_param <= 32));
            }
            matched = true;
        }
    }
    if !matched {
        if (field_type_len >= 4)
            & (lower_ascii(field_type[0]) == 117)
            & (lower_ascii(field_type[1]) == 105)
            & (lower_ascii(field_type[2]) == 110)
            & (lower_ascii(field_type[3]) == 116)
        {
            type_kind = TYPE_KIND_UINT;
            if field_type_len == 4 {
                type_param = 256;
            } else {
                type_param = parse_decimal_ascii(field_type, 4, field_type_len);
            }
            assert((type_param >= 8) & (type_param <= 128) & (type_param % 8 == 0));
            matched = true;
        }
    }
    if !matched {
        if (field_type_len >= 3)
            & (lower_ascii(field_type[0]) == 105)
            & (lower_ascii(field_type[1]) == 110)
            & (lower_ascii(field_type[2]) == 116)
        {
            type_kind = TYPE_KIND_INT;
            if field_type_len == 3 {
                type_param = 256;
            } else {
                type_param = parse_decimal_ascii(field_type, 3, field_type_len);
            }
            assert((type_param >= 8) & (type_param <= 128) & (type_param % 8 == 0));
            matched = true;
        }
    }

    assert(matched);
    (type_kind, type_param)
}

fn parse_decimal_ascii(
    bytes: [u8; MAX_FIELD_TYPE_BYTES],
    start: u32,
    end: u32,
) -> u32 {
    let mut value = 0;
    for i in 0..MAX_FIELD_TYPE_BYTES {
        if (i >= start) & (i < end) {
            assert((bytes[i] >= 48) & (bytes[i] <= 57));
            value = value * 10 + (bytes[i] - 48) as u32;
        }
    }
    value
}

fn parse_uint_word(
    bytes: [u8; MAX_STRUCTURED_OUTPUT_BYTES],
    len: u32,
    start: u32,
    end: u32,
    bit_width: u32,
) -> [u8; 32] {
    let mut value = 0 as u128;
    if bytes[start] == 34 {
        let (raw, raw_len, _) =
            parse_json_string_at::<MAX_STRUCTURED_OUTPUT_BYTES, 64>(bytes, len, start);
        value = parse_u128_decimal(raw, raw_len);
    } else {
        let (raw, raw_len) = capture_primitive(bytes, len, start, end);
        value = parse_u128_decimal(raw, raw_len);
    }
    assert_u128_fits_bits(value, bit_width);
    u128_to_word(value)
}

fn parse_int_word(
    bytes: [u8; MAX_STRUCTURED_OUTPUT_BYTES],
    len: u32,
    start: u32,
    end: u32,
    bit_width: u32,
) -> [u8; 32] {
    let mut value = (false, 0 as u128);
    if bytes[start] == 34 {
        let (raw, raw_len, _) =
            parse_json_string_at::<MAX_STRUCTURED_OUTPUT_BYTES, 64>(bytes, len, start);
        value = parse_signed_decimal(raw, raw_len);
    } else {
        let (raw, raw_len) = capture_primitive(bytes, len, start, end);
        value = parse_signed_decimal(raw, raw_len);
    }
    assert_i128_fits_bits(value, bit_width);
    signed_magnitude_to_word(value)
}

fn assert_u128_fits_bits(value: u128, bit_width: u32) {
    if bit_width < 128 {
        assert(value < pow2_u128(bit_width));
    }
}

fn assert_i128_fits_bits(value: (bool, u128), bit_width: u32) {
    let (negative, magnitude) = value;
    let limit = pow2_u128(bit_width - 1);
    if negative {
        assert(magnitude <= limit);
    } else {
        assert(magnitude < limit);
    }
}

fn pow2_u128(bits: u32) -> u128 {
    let mut out = 1 as u128;
    for i in 0..128 {
        if i < bits {
            out = out * 2;
        }
    }
    out
}

fn parse_bool_value<let N: u32>(
    bytes: [u8; N],
    len: u32,
    start: u32,
    end: u32,
) -> bool {
    if bytes[start] == 34 {
        let (raw, raw_len, _) =
            parse_json_string_at::<N, 8>(bytes, len, start);
        if matches_bytes(raw, raw_len, [116, 114, 117, 101, 0, 0, 0, 0], 4) {
            true
        } else {
            assert(matches_bytes(raw, raw_len, [102, 97, 108, 115, 101, 0, 0, 0], 5));
            false
        }
    } else {
        parse_bool_range(bytes, len, start, end)
    }
}

fn parse_bool_range<let N: u32>(
    bytes: [u8; N],
    _len: u32,
    start: u32,
    end: u32,
) -> bool {
    let (raw, raw_len) = capture_primitive(bytes, end, start, end);
    if matches_bytes(raw, raw_len, [116, 114, 117, 101, 0], 4) {
        true
    } else {
        assert(matches_bytes(raw, raw_len, [102, 97, 108, 115, 101], 5));
        false
    }
}

fn parse_u128_decimal(bytes: [u8; 64], len: u32) -> u128 {
    let mut value = 0 as u128;
    for i in 0..64 {
        if i < len {
            assert((bytes[i] >= 48) & (bytes[i] <= 57));
            value = value * 10 + (bytes[i] - 48) as u128;
        }
    }
    value
}

fn parse_signed_decimal(bytes: [u8; 64], len: u32) -> (bool, u128) {
    if (len > 0) & (bytes[0] == 45) {
        let mut trimmed = [0 as u8; 64];
        for i in 1..64 {
            if i < len {
                trimmed[i - 1] = bytes[i];
            }
        }
        (true, parse_u128_decimal(trimmed, len - 1))
    } else {
        (false, parse_u128_decimal(bytes, len))
    }
}

fn signed_magnitude_to_word(value: (bool, u128)) -> [u8; 32] {
    let (negative, magnitude) = value;
    if !negative {
        u128_to_word(magnitude)
    } else {
        let low = (!magnitude) + 1;
        let low_bytes = u128_to_be_bytes(low);
        let mut word = [255 as u8; 32];
        for i in 0..16 {
            word[16 + i] = low_bytes[i];
        }
        word
    }
}

fn u128_to_word(value: u128) -> [u8; 32] {
    let mut word = [0 as u8; 32];
    let raw = u128_to_be_bytes(value);
    for i in 0..16 {
        word[16 + i] = raw[i];
    }
    word
}

fn u128_to_be_bytes(value: u128) -> [u8; 16] {
    let mut out = [0 as u8; 16];
    let mut remaining = value;
    for i in 0..16 {
        let idx = i as u32;
        let shift = ((15 - idx) * 8) as u128;
        out[idx] = ((remaining >> shift) & (0xff as u128)) as u8;
    }
    out
}

fn bool_to_word(value: bool) -> [u8; 32] {
    let mut word = [0 as u8; 32];
    if value {
        word[31] = 1;
    }
    word
}

fn address_string_to_word(value: [u8; 64], value_len: u32) -> [u8; 32] {
    let decoded = hex_decode_exact(value, value_len, 20);
    let mut word = [0 as u8; 32];
    for i in 0..20 {
        word[12 + i] = decoded[i];
    }
    word
}

fn fixed_bytes_to_word<let N: u32>(value: [u8; N], value_len: u32) -> [u8; 32] {
    assert(value_len <= 32);
    let mut word = [0 as u8; 32];
    for i in 0..32 {
        if i < value_len {
            word[i] = value[i];
        }
    }
    word
}

fn decode_bytes_string<let N: u32>(
    value: [u8; N],
    value_len: u32,
) -> ([u8; MAX_DYNAMIC_BYTES], u32) {
    if (value_len >= 2) & (value[0] == 48) & ((value[1] == 120) | (value[1] == 88)) {
        let mut out = [0 as u8; MAX_DYNAMIC_BYTES];
        let hex_len = value_len - 2;
        assert(hex_len % 2 == 0);
        let mut out_len = 0;
        for i in 0..MAX_DYNAMIC_BYTES {
            let idx = 2 + i * 2;
            if idx + 1 < value_len {
                out[out_len] = (hex_nibble(value[idx]) * 16) + hex_nibble(value[idx + 1]);
                out_len += 1;
            }
        }
        (out, out_len)
    } else {
        let mut out = [0 as u8; MAX_DYNAMIC_BYTES];
        for i in 0..MAX_DYNAMIC_BYTES {
            if i < value_len {
                out[i] = value[i];
            }
        }
        (out, value_len)
    }
}

fn hex_string_to_bytes32(value: [u8; 66], value_len: u32) -> [u8; 32] {
    let decoded = hex_decode_exact(value, value_len, 32);
    let mut out = [0 as u8; 32];
    for i in 0..32 {
        out[i] = decoded[i];
    }
    out
}

fn hex_decode_exact<let N: u32>(
    value: [u8; N],
    value_len: u32,
    expected_bytes: u32,
) -> [u8; 32] {
    let mut start = 0;
    if (value_len >= 2) & (value[0] == 48) & ((value[1] == 120) | (value[1] == 88)) {
        start = 2;
    }
    assert(value_len - start == expected_bytes * 2);
    let mut out = [0 as u8; 32];
    for i in 0..32 {
        if i < expected_bytes {
            out[i] = (hex_nibble(value[start + i * 2]) * 16) + hex_nibble(value[start + i * 2 + 1]);
        }
    }
    out
}

fn capture_primitive<let N: u32>(
    bytes: [u8; N],
    _len: u32,
    start: u32,
    end: u32,
) -> ([u8; 64], u32) {
    let mut out = [0 as u8; 64];
    let mut out_len = 0;
    for i in 0..64 {
        let idx = start + i;
        if idx < end {
            out[out_len] = bytes[idx];
            out_len += 1;
        }
    }
    (out, out_len)
}

fn find_object_value_range<let N: u32, let KEY: u32>(
    bytes: [u8; N],
    len: u32,
    object_start: u32,
    key_len: u32,
    key: [u8; KEY],
) -> (u32, u32, bool) {
    let mut idx = skip_ws(bytes, len, object_start);
    assert(bytes[idx] == 123);
    idx += 1;

    let mut value_start = 0;
    let mut value_end = 0;
    let mut found = false;
    let mut finished = false;

    for _ in 0..N {
        if !finished {
            idx = skip_ws(bytes, len, idx);
            if idx < len {
                if bytes[idx] == 125 {
                    finished = true;
                }
            } else {
                assert(false);
            }
            if !finished {
                let (parsed_key, parsed_key_len, next_idx) =
                    parse_json_string_at::<N, MAX_RESPONSE_KEY_NAME_BYTES>(bytes, len, idx);
                idx = skip_ws(bytes, len, next_idx);
                assert(bytes[idx] == 58);
                idx += 1;
                idx = skip_ws(bytes, len, idx);
                let next_value_start = idx;
                let next_value_end = skip_json_value(bytes, len, next_value_start);
                if (parsed_key_len == key_len) & bytes_equal(parsed_key, parsed_key_len, key, key_len) {
                    assert(!found);
                    value_start = next_value_start;
                    value_end = next_value_end;
                    found = true;
                }
                idx = skip_ws(bytes, len, next_value_end);
                if idx < len {
                    if bytes[idx] == 44 {
                        idx += 1;
                    } else {
                        assert(bytes[idx] == 125);
                        finished = true;
                    }
                } else {
                    assert(false);
                }
            }
        }
    }

    assert(finished);
    (value_start, value_end, found)
}

fn find_array_element_range<let N: u32>(
    bytes: [u8; N],
    len: u32,
    array_start: u32,
    target_index: u32,
) -> (u32, u32, bool) {
    let mut idx = skip_ws(bytes, len, array_start);
    assert(bytes[idx] == 91);
    idx += 1;

    let mut current_index = 0;
    let mut value_start = 0;
    let mut value_end = 0;
    let mut found = false;
    let mut finished = false;

    for _ in 0..N {
        if !finished {
            idx = skip_ws(bytes, len, idx);
            if idx < len {
                if bytes[idx] == 93 {
                    finished = true;
                }
            } else {
                assert(false);
            }
            if !finished {
                let next_value_start = idx;
                let next_value_end = skip_json_value(bytes, len, next_value_start);
                if current_index == target_index {
                    value_start = next_value_start;
                    value_end = next_value_end;
                    found = true;
                }
                idx = skip_ws(bytes, len, next_value_end);
                if idx < len {
                    if bytes[idx] == 44 {
                        idx += 1;
                        current_index += 1;
                    } else {
                        assert(bytes[idx] == 93);
                        finished = true;
                    }
                } else {
                    assert(false);
                }
            }
        }
    }

    assert(finished);
    (value_start, value_end, found)
}

fn count_array_entries<let N: u32>(
    bytes: [u8; N],
    len: u32,
    array_start: u32,
) -> u32 {
    let mut idx = skip_ws(bytes, len, array_start);
    assert(bytes[idx] == 91);
    idx += 1;

    let mut count = 0;
    let mut finished = false;

    for _ in 0..N {
        if !finished {
            idx = skip_ws(bytes, len, idx);
            if idx < len {
                if bytes[idx] == 93 {
                    finished = true;
                }
            } else {
                assert(false);
            }
            if !finished {
                idx = skip_json_value(bytes, len, idx);
                count += 1;
                idx = skip_ws(bytes, len, idx);
                if idx < len {
                    if bytes[idx] == 44 {
                        idx += 1;
                    } else {
                        assert(bytes[idx] == 93);
                        finished = true;
                    }
                } else {
                    assert(false);
                }
            }
        }
    }

    assert(finished);
    count
}

fn count_object_entries<let N: u32>(
    bytes: [u8; N],
    len: u32,
    object_start: u32,
) -> u32 {
    let mut idx = skip_ws(bytes, len, object_start);
    assert(bytes[idx] == 123);
    idx += 1;

    let mut count = 0;
    let mut finished = false;

    for _ in 0..N {
        if !finished {
            idx = skip_ws(bytes, len, idx);
            if idx < len {
                if bytes[idx] == 125 {
                    finished = true;
                }
            } else {
                assert(false);
            }
            if !finished {
                let (_, _, next_idx) =
                    parse_json_string_at::<N, MAX_FIELD_NAME_BYTES>(bytes, len, idx);
                idx = skip_ws(bytes, len, next_idx);
                assert(bytes[idx] == 58);
                idx += 1;
                idx = skip_ws(bytes, len, idx);
                idx = skip_json_value(bytes, len, idx);
                count += 1;
                idx = skip_ws(bytes, len, idx);
                if idx < len {
                    if bytes[idx] == 44 {
                        idx += 1;
                    } else {
                        assert(bytes[idx] == 125);
                        finished = true;
                    }
                } else {
                    assert(false);
                }
            }
        }
    }

    assert(finished);
    count
}

fn parse_json_string_at<let N: u32, let OUT: u32>(
    bytes: [u8; N],
    len: u32,
    start: u32,
) -> ([u8; OUT], u32, u32) {
    let mut idx = skip_ws(bytes, len, start);
    assert(bytes[idx] == 34);
    idx += 1;

    let mut out = [0 as u8; OUT];
    let mut out_len = 0;
    let mut next_idx = 0;
    let mut finished = false;

    for _ in 0..N {
        if !finished {
            assert(idx < len);
            let ch = bytes[idx];
            if ch == 34 {
                next_idx = idx + 1;
                finished = true;
            } else if ch == 92 {
                idx += 1;
                assert(idx < len);
                let esc = bytes[idx];
                if (esc == 34) | (esc == 92) | (esc == 47) {
                    out[out_len] = esc;
                    out_len += 1;
                    idx += 1;
                } else if esc == 98 {
                    out[out_len] = 8;
                    out_len += 1;
                    idx += 1;
                } else if esc == 102 {
                    out[out_len] = 12;
                    out_len += 1;
                    idx += 1;
                } else if esc == 110 {
                    out[out_len] = 10;
                    out_len += 1;
                    idx += 1;
                } else if esc == 114 {
                    out[out_len] = 13;
                    out_len += 1;
                    idx += 1;
                } else if esc == 116 {
                    out[out_len] = 9;
                    out_len += 1;
                    idx += 1;
                } else {
                    assert(esc == 117);
                    assert(idx + 4 < len);
                    assert(bytes[idx + 1] == 48);
                    assert(bytes[idx + 2] == 48);
                    out[out_len] = (hex_nibble(bytes[idx + 3]) * 16) + hex_nibble(bytes[idx + 4]);
                    out_len += 1;
                    idx += 5;
                }
            } else {
                out[out_len] = ch;
                out_len += 1;
                idx += 1;
            }
        }
    }

    assert(finished);
    (out, out_len, next_idx)
}

fn skip_json_value<let N: u32>(
    bytes: [u8; N],
    len: u32,
    start: u32,
) -> u32 {
    let idx = skip_ws(bytes, len, start);
    let ch = bytes[idx];
    let mut out = idx;
    if ch == 34 {
        out = skip_json_string(bytes, len, idx);
    } else if (ch == 123) | (ch == 91) {
        let mut cursor = idx;
        let mut object_depth = 0;
        let mut array_depth = 0;
        let mut in_string = false;
        let mut escaping = false;
        let mut done = false;
        for _ in 0..N {
            if !done {
                assert(cursor < len);
                let current = bytes[cursor];
                if in_string {
                    if escaping {
                        escaping = false;
                        cursor += 1;
                    } else if current == 92 {
                        escaping = true;
                        cursor += 1;
                    } else if current == 34 {
                        in_string = false;
                        cursor += 1;
                    } else {
                        cursor += 1;
                    }
                } else if current == 34 {
                    in_string = true;
                    cursor += 1;
                } else {
                    if current == 123 {
                        object_depth += 1;
                    } else if current == 125 {
                        assert(object_depth > 0);
                        object_depth -= 1;
                    } else if current == 91 {
                        array_depth += 1;
                    } else if current == 93 {
                        assert(array_depth > 0);
                        array_depth -= 1;
                    }
                    cursor += 1;
                    if (object_depth == 0) & (array_depth == 0) {
                        done = true;
                        out = cursor;
                    }
                }
            }
        }
        assert(done);
    } else {
        let mut cursor = idx;
        for _ in 0..N {
            if cursor < len {
                if !is_primitive_delimiter(bytes[cursor]) {
                    cursor += 1;
                }
            }
        }
        out = cursor;
    }
    out
}

fn skip_json_string<let N: u32>(
    bytes: [u8; N],
    len: u32,
    start: u32,
) -> u32 {
    let mut cursor = start + 1;
    let mut escaping = false;
    let mut finished = false;
    let mut out = start;
    for _ in 0..N {
        if !finished {
            assert(cursor < len);
            let current = bytes[cursor];
            if escaping {
                escaping = false;
                cursor += 1;
            } else if current == 92 {
                escaping = true;
                cursor += 1;
            } else if current == 34 {
                out = cursor + 1;
                finished = true;
            } else {
                cursor += 1;
            }
        }
    }
    assert(finished);
    out
}

fn assert_hash_matches_public<let N: u32>(
    public_inputs: [Field; PREFIX_PUBLIC_INPUTS],
    hi_index: u32,
    lo_index: u32,
    bytes: [u8; N],
    len: u32,
) {
    let hash = keccak256_var(bytes, len);
    let (hi, lo) = bytes32_to_fields(hash);
    assert(public_inputs[hi_index] == hi);
    assert(public_inputs[lo_index] == lo);
}

fn bytes32_to_fields(bytes: [u8; 32]) -> (Field, Field) {
    let mut hi = 0 as Field;
    let mut lo = 0 as Field;
    for i in 0..16 {
        hi = hi * 256 + bytes[i] as Field;
        lo = lo * 256 + bytes[16 + i] as Field;
    }
    (hi, lo)
}

fn assert_chunked_bytes<let MAX_BYTES: u32, let CHUNK_COUNT: u32>(
    bytes: [u8; MAX_BYTES],
    len: u32,
    chunks: [Field; CHUNK_COUNT],
    chunk_count: u32,
) {
    assert(chunk_count == expected_chunk_count(len));
    for chunk_idx in 0..CHUNK_COUNT {
        if chunk_idx < chunk_count {
            let start = chunk_idx * 31;
            let mut chunk_field = 0 as Field;
            for j in 0..31 {
                let idx = start + j;
                let byte = if idx < len {
                    bytes[idx]
                } else {
                    0 as u8
                };
                chunk_field = chunk_field * 256 + byte as Field;
            }
            assert(chunks[chunk_idx] == chunk_field);
        } else {
            assert(chunks[chunk_idx] == 0);
        }
    }
}

fn append_bytes<let TARGET: u32, let SRC: u32>(
    target: [u8; TARGET],
    offset: u32,
    source_len: u32,
    source: [u8; SRC],
) -> ([u8; TARGET], u32) {
    assert(source_len <= SRC);
    assert(offset + source_len <= TARGET);

    let mut out = target;
    for i in 0..SRC {
        if i < source_len {
            out[offset + i] = source[i];
        }
    }

    (out, offset + source_len)
}

fn keccak256_var<let N: u32>(input: [u8; N], input_len: u32) -> [u8; 32] {
    assert(input_len <= N);

    let mut state = [0 as u64; 25];
    let full_blocks = input_len / KECCAK_RATE_BYTES;

    for block_idx in 0..((N + KECCAK_RATE_BYTES - 1) / KECCAK_RATE_BYTES) {
        if block_idx < full_blocks {
            let mut block = [0 as u8; KECCAK_RATE_BYTES];
            let start = block_idx * KECCAK_RATE_BYTES;
            for i in 0..KECCAK_RATE_BYTES {
                block[i] = input[start + i];
            }
            state = absorb_keccak_block(state, block);
            state = std::hash::keccakf1600(state);
        }
    }

    let mut final_block = [0 as u8; KECCAK_RATE_BYTES];
    let remainder = input_len - (full_blocks * KECCAK_RATE_BYTES);
    let final_start = full_blocks * KECCAK_RATE_BYTES;
    for i in 0..KECCAK_RATE_BYTES {
        if i < remainder {
            final_block[i] = input[final_start + i];
        }
    }

    final_block[remainder] = final_block[remainder] ^ 0x01;
    final_block[KECCAK_RATE_BYTES - 1] = final_block[KECCAK_RATE_BYTES - 1] ^ 0x80;

    state = absorb_keccak_block(state, final_block);
    state = std::hash::keccakf1600(state);
    squeeze_keccak256(state)
}

fn sha256_var<let N: u32, let MAX_BLOCKS: u32>(
    input: [u8; N],
    input_len: u32,
) -> [u8; 32] {
    assert(input_len <= N);

    let total_blocks = (input_len + 72) / SHA256_BLOCK_BYTES;
    assert(total_blocks <= MAX_BLOCKS);

    let mut state: [u32; 8] = [
        1779033703,
        3144134277,
        1013904242,
        2773480762,
        1359893119,
        2600822924,
        528734635,
        1541459225,
    ];
    let message_bits = (input_len as u64) * 8;

    for block_idx in 0..MAX_BLOCKS {
        if block_idx < total_blocks {
            let mut block = [0 as u8; 64];
            let block_start = block_idx * 64;
            for i in 0..64 {
                let absolute_idx = block_start + i;
                let final_length_start = total_blocks * 64 - 8;
                if absolute_idx < input_len {
                    block[i] = input[absolute_idx];
                } else if absolute_idx == input_len {
                    block[i] = 0x80;
                } else if absolute_idx >= final_length_start {
                    let shift = ((final_length_start + 7 - absolute_idx) * 8) as u64;
                    block[i] = ((message_bits >> shift) & (0xff as u64)) as u8;
                }
            }

            let mut words = [0 as u32; 16];
            for i in 0..16 {
                words[i] = bytes4_to_u32_be(
                    block[i * 4],
                    block[i * 4 + 1],
                    block[i * 4 + 2],
                    block[i * 4 + 3],
                );
            }
            state = std::hash::sha256_compression(words, state);
        }
    }

    let mut out = [0 as u8; 32];
    for i in 0..8 {
        let bytes = u32_to_be_bytes(state[i]);
        for j in 0..4 {
            out[i * 4 + j] = bytes[j];
        }
    }
    out
}

fn absorb_keccak_block(state: [u64; 25], block: [u8; KECCAK_RATE_BYTES]) -> [u64; 25] {
    let mut out = state;
    for lane_idx in 0..17 {
        out[lane_idx] = out[lane_idx] ^ bytes8_to_u64_le(
            block[lane_idx * 8],
            block[lane_idx * 8 + 1],
            block[lane_idx * 8 + 2],
            block[lane_idx * 8 + 3],
            block[lane_idx * 8 + 4],
            block[lane_idx * 8 + 5],
            block[lane_idx * 8 + 6],
            block[lane_idx * 8 + 7],
        );
    }
    out
}

fn squeeze_keccak256(state: [u64; 25]) -> [u8; 32] {
    let mut out = [0 as u8; 32];
    for lane_idx in 0..4 {
        let bytes = u64_to_le_bytes(state[lane_idx]);
        for j in 0..8 {
            out[lane_idx * 8 + j] = bytes[j];
        }
    }
    out
}

fn bytes8_to_u64_le(
    b0: u8,
    b1: u8,
    b2: u8,
    b3: u8,
    b4: u8,
    b5: u8,
    b6: u8,
    b7: u8,
) -> u64 {
    (b0 as u64)
        + ((b1 as u64) << 8)
        + ((b2 as u64) << 16)
        + ((b3 as u64) << 24)
        + ((b4 as u64) << 32)
        + ((b5 as u64) << 40)
        + ((b6 as u64) << 48)
        + ((b7 as u64) << 56)
}

fn bytes4_to_u32_be(b0: u8, b1: u8, b2: u8, b3: u8) -> u32 {
    ((b0 as u32) << 24)
        + ((b1 as u32) << 16)
        + ((b2 as u32) << 8)
        + (b3 as u32)
}

fn u32_to_be_bytes(value: u32) -> [u8; 4] {
    [
        ((value >> 24) & 0xff) as u8,
        ((value >> 16) & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        (value & 0xff) as u8,
    ]
}

fn u64_to_le_bytes(value: u64) -> [u8; 8] {
    [
        (value & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        ((value >> 16) & 0xff) as u8,
        ((value >> 24) & 0xff) as u8,
        ((value >> 32) & 0xff) as u8,
        ((value >> 40) & 0xff) as u8,
        ((value >> 48) & 0xff) as u8,
        ((value >> 56) & 0xff) as u8,
    ]
}

fn address_bytes_to_field(address: [u8; 20]) -> Field {
    let mut out = 0 as Field;
    for i in 0..20 {
        out = out * 256 + address[i] as Field;
    }
    out
}

fn address_to_abi_word(address: [u8; 20]) -> [u8; 32] {
    let mut word = [0 as u8; 32];
    for i in 0..20 {
        word[12 + i] = address[i];
    }
    word
}

fn bool_to_abi_word(value: bool) -> [u8; 32] {
    let mut word = [0 as u8; 32];
    if value {
        word[31] = 1;
    }
    word
}

fn expected_chunk_count(len: u32) -> u32 {
    if len == 0 {
        0
    } else {
        ((len - 1) / 31) + 1
    }
}

fn padded_len(len: u32) -> u32 {
    if len == 0 {
        0
    } else {
        ((len + 31) / 32) * 32
    }
}

fn u32_to_abi_word(value: u32) -> [u8; 32] {
    let mut word = [0 as u8; 32];
    word[28] = ((value >> 24) & 0xff) as u8;
    word[29] = ((value >> 16) & 0xff) as u8;
    word[30] = ((value >> 8) & 0xff) as u8;
    word[31] = (value & 0xff) as u8;
    word
}

fn u64_to_abi_word(value: u64) -> [u8; 32] {
    let mut word = [0 as u8; 32];
    word[24] = ((value >> 56) & 0xff) as u8;
    word[25] = ((value >> 48) & 0xff) as u8;
    word[26] = ((value >> 40) & 0xff) as u8;
    word[27] = ((value >> 32) & 0xff) as u8;
    word[28] = ((value >> 24) & 0xff) as u8;
    word[29] = ((value >> 16) & 0xff) as u8;
    word[30] = ((value >> 8) & 0xff) as u8;
    word[31] = (value & 0xff) as u8;
    word
}

fn skip_ws<let N: u32>(bytes: [u8; N], len: u32, start: u32) -> u32 {
    let mut idx = start;
    for _ in 0..N {
        if idx < len {
            if is_whitespace(bytes[idx]) {
                idx += 1;
            }
        }
    }
    idx
}

fn is_whitespace(value: u8) -> bool {
    (value == 32) | (value == 9) | (value == 10) | (value == 13)
}

fn is_primitive_delimiter(value: u8) -> bool {
    is_whitespace(value) | (value == 44) | (value == 93) | (value == 125)
}

fn bytes_equal<let A: u32, let B: u32>(
    a: [u8; A],
    a_len: u32,
    b: [u8; B],
    b_len: u32,
) -> bool {
    let mut equal = a_len == b_len;
    for i in 0..A {
        if equal {
            if i < a_len {
                if a[i] != b[i] {
                    equal = false;
                }
            }
        }
    }
    equal
}

fn matches_bytes<let A: u32, let B: u32>(
    a: [u8; A],
    a_len: u32,
    b: [u8; B],
    b_len: u32,
) -> bool {
    bytes_equal(a, a_len, b, b_len)
}

fn slice_matches_at<let A: u32, let B: u32>(
    haystack: [u8; A],
    haystack_len: u32,
    start: u32,
    needle: [u8; B],
    needle_len: u32,
) -> bool {
    let mut equal = start + needle_len <= haystack_len;
    if equal {
        for i in 0..B {
            if i < needle_len {
                if haystack[start + i] != needle[i] {
                    equal = false;
                }
            }
        }
    }
    equal
}

fn matches_ascii_insensitive<let N: u32, let M: u32>(
    value: [u8; N],
    value_len: u32,
    expected: [u8; M],
    expected_len: u32,
) -> bool {
    let mut equal = value_len == expected_len;
    for i in 0..M {
        if equal {
            if i < expected_len {
                if lower_ascii(value[i]) != lower_ascii(expected[i]) {
                    equal = false;
                }
            }
        }
    }
    equal
}

fn lower_ascii(value: u8) -> u8 {
    if (value >= 65) & (value <= 90) {
        value + 32
    } else {
        value
    }
}

fn hex_nibble(value: u8) -> u8 {
    if (value >= 48) & (value <= 57) {
        value - 48
    } else if (value >= 97) & (value <= 102) {
        value - 87
    } else {
        assert((value >= 65) & (value <= 70));
        value - 55
    }
}
