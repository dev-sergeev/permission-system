from pathlib import Path

folder = Path(__file__).parent
rows = folder.joinpath("rows.txt").read_text(encoding="utf-8").splitlines()
report = f"rows={sum(bool(row.strip()) for row in rows)}"
folder.joinpath("count-result.txt").write_text(report + "\n", encoding="utf-8")
print(report)
