use sp1_sdk::{include_elf, HashableKey, Prover, ProverClient};

pub const THASSA_ZKVM_ELF: &[u8] = include_elf!("thassa-zkvm-program");

fn main() {
    let prover = ProverClient::from_env();
    let (_, vk) = prover.setup(THASSA_ZKVM_ELF);
    println!("program_vkey_hash={}", vk.bytes32());
    println!("program_vkey_hash_raw=0x{}", hex::encode(vk.bytes32_raw()));
}
