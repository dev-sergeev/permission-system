from pathlib import Path

rows = Path(__file__).with_name("rows.txt").read_text(encoding="utf-8").splitlines()
print(f"rows={sum(bool(row.strip()) for row in rows)}")
