"""Stream a WAV into the emulator's virtual microphone via gRPC injectAudio (dev test helper).

Start the emulator with `-grpc 8554 -grpc-use-token` (localhost, console-token auth).
usage: uv run --with grpcio --with grpcio-tools inject_audio.py <file.wav> [port]
"""
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import grpc
from grpc_tools import protoc

PROTO_DIR = Path.home() / "Android/Sdk/emulator/lib"
RATE = 16_000
CHUNK = RATE * 2 // 50  # 20 ms of 16-bit mono

out = Path(tempfile.mkdtemp())
protoc.main(["protoc", f"-I{PROTO_DIR}", f"-I{Path(protoc.__file__).parent / '_proto'}",
             f"--python_out={out}", f"--grpc_python_out={out}", str(PROTO_DIR / "emulator_controller.proto")])
sys.path.insert(0, str(out))
import emulator_controller_pb2 as pb  # noqa: E402
import emulator_controller_pb2_grpc as pb_grpc  # noqa: E402

# --burst: push packets as fast as the emulator accepts them, 0.5 s padding (the mode that worked);
# default: real-time pacing with 3 s padding.
burst = "--burst" in sys.argv
args = [a for a in sys.argv[1:] if a != "--burst"]
wav, port = args[0], (args[1] if len(args) > 1 else "8554")
pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", wav, "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
                     check=True, capture_output=True).stdout
pad = bytes(RATE) if burst else bytes(RATE * 2 * 3)
pcm = pad + pcm + pad
fmt = pb.AudioFormat(samplingRate=RATE, channels=pb.AudioFormat.Mono, format=pb.AudioFormat.AUD_FMT_S16)


def packets():
    t0 = time.monotonic()
    for n, i in enumerate(range(0, len(pcm), CHUNK)):
        if not burst:
            time.sleep(max(0.0, t0 + n * 0.02 - time.monotonic()))
        yield pb.AudioPacket(format=fmt, timestamp=int(time.time() * 1e6), audio=pcm[i:i + CHUNK])


# The running emulator advertises its gRPC token in its discovery file.
discovery = max(Path(f"/run/user/{__import__('os').getuid()}/avd/running").glob("pid_*.ini"), key=lambda p: p.stat().st_mtime)
token = next(line.split("=", 1)[1] for line in discovery.read_text().splitlines() if line.startswith("grpc.token="))
stub = pb_grpc.EmulatorControllerStub(grpc.insecure_channel(f"localhost:{port}"))
start = time.time()
stub.injectAudio(packets(), metadata=[("authorization", f"Bearer {token}")])
print(f"injected {len(pcm) / (RATE * 2):.1f}s of audio in {time.time() - start:.1f}s")
