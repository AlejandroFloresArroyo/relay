#!/bin/bash
# Main process of a real flow-control test. Once the test creates `go` in its folder, it writes
# `size` bytes (also a file there) of 'x' to the terminal as fast as it can, then creates `done`:
# every write returned.
until [ -f go ]; do sleep 0.02; done
head -c "$(cat size)" /dev/zero | tr '\0' x
touch done
exec sleep 300
