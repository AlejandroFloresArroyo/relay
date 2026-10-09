#!/bin/sh
# Main process that writes the moment it starts, before anything could be reading it.
printf 'FIRST-OUTPUT-LINE\n'
exec sleep 300
