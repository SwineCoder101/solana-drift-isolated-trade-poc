use std::{fs::File, path::Path};

use anyhow::Result;
use dotenvy::dotenv;
use rust_api::decoder::{ActionRecord, DriftDecoder, SignatureDump};

const WITHDRAW_FROM_ISOLATED_PERP_POSITION_SIGNATURE: &str =
    "4mXkvzqN1n8WmF82Xb9C9teZhF6GJeGkUcupNshLFBdiB8idTuWET3BzTtgNZo4bvnPgKbRusQCX9pXjGTpSdF3K";
const PLACE_PERP_ORDER_SIGNATURE: &str =
    "MnmqKomt5SZW2YYmic3aUqi8LFCSr6tGxngsiJfW8s1NTZdmvNrUW6h2C8Uz3D8UuzFeedgsthWSqqvz7rEz8Cv";
const DEPOSIT_INTO_ISOLATED_PERP_POSITION_SIGNATURE: &str =
    "4w1WV3b8Z1FkE4W5JzyMyc3SR2jLP5jaoDQPNxfDTWZJtR9p5dFSa7zsaDQgDedy2D4DDi8LAY6LXKndRqTHCk5X";

fn main() -> Result<()> {
    dotenv().ok();
    let decoder = DriftDecoder::from_env()?;

    let dump_root = Path::new("decoder-dumps");
    std::fs::create_dir_all(dump_root)?;

    let signatures = [
        (
            "withdrawFromIsolatedPerpPosition",
            WITHDRAW_FROM_ISOLATED_PERP_POSITION_SIGNATURE,
        ),
        ("placePerpOrder", PLACE_PERP_ORDER_SIGNATURE),
        (
            "depositIntoIsolatedPerpPosition",
            DEPOSIT_INTO_ISOLATED_PERP_POSITION_SIGNATURE,
        ),
    ];

    let mut action_rows: Vec<ActionRecord> = Vec::new();
    for (label, sig) in signatures {
        println!("=========================");
        println!("Signature: {sig} ({label})");
        match decoder.decode_signature(sig) {
            Ok((dump, mut actions)) => {
                print_dump_summary(&dump);
                action_rows.append(&mut actions);
                write_dump(dump_root, sig, &dump)?;
            }
            Err(err) => eprintln!("  !! failed to decode {sig}: {err:?}"),
        }
    }

    if !action_rows.is_empty() {
        let path = dump_root.join("aggregated-actions.json");
        let file = File::create(&path)?;
        serde_json::to_writer_pretty(file, &action_rows)?;
        println!("\nWrote aggregated actions to {}", path.display());
    }

    Ok(())
}

fn write_dump(root: &Path, signature: &str, dump: &SignatureDump) -> Result<()> {
    let path = root.join(format!("{signature}.json"));
    let file = File::create(&path)?;
    serde_json::to_writer_pretty(file, dump)?;
    println!("  wrote {}", path.display());
    Ok(())
}

fn print_dump_summary(dump: &SignatureDump) {
    println!("  Slot: {}", dump.slot);
    if let Some(ts) = dump.block_time {
        println!("  Block time (unix): {ts}");
    }
    for instr in &dump.instructions {
        let label = instr.kind.as_deref().unwrap_or("unknown Drift instruction");
        println!("  ix {}: {} ({} bytes)", instr.index, label, instr.data_len);
    }
}
