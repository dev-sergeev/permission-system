import subprocess

# Port zero on loopback cannot name a live HDFS service. Never substitute a cluster URI.
subprocess.run(["hadoop", "fs", "-rm", "hdfs://127.0.0.1:0/pi-test/keep.txt"], check=True)
