#!/usr/bin/env bash
# NOTE: this WSL-side launcher is superseded — see scripts/live-test.bat.
#
# A Chrome running on Windows only listens on its own loopback interface, which WSL
# cannot reach, and branded Chrome ignores --load-extension. The live test therefore
# runs on the Windows side (Windows node.exe + CDP Extensions.loadUnpacked).
#
# Run it from WSL with, e.g.:
#   cmd.exe /c "C:\\path\\to\\datNowPlaying\\scripts\\live-test.bat" "C:\\path\\to\\datNowPlaying"
#
# The unit + static checks DO run fine in WSL:
#   bash scripts/validate.sh
#   node tests/run.js
echo "Use scripts/live-test.bat on the Windows side. In-WSL: 'bash scripts/validate.sh' and 'node tests/run.js'."
exit 0
