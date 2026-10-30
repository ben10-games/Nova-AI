# Runs the Syntaz Blender Bridge inside a headless Blender for automated tests:
#   blender --background --factory-startup --python test/fixtures/blender_headless.py -- <port> <token_file>
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "blender-addon"))
import nova_blender_bridge as bridge  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
bridge.serve_blocking(int(args[0]), args[1])
