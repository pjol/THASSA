use clap::Parser;
use std::{fs, path::PathBuf};

pub const THASSA_ZKVM_ELF: &[u8] = sp1_sdk::include_elf!("thassa-zkvm-program");

#[derive(Parser, Debug)]
struct Args {
    #[arg(long, default_value = "../../artifacts/thassa-zkvm-program.elf")]
    out: PathBuf,
}

fn main() {
    let args = Args::parse();
    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent).expect("create ELF output directory");
    }
    fs::write(&args.out, THASSA_ZKVM_ELF).expect("write ELF bytes");
    println!("{}", args.out.display());
}
