#!/bin/bash

# Check if Node.js process is running
if ! pgrep -f "tsx.*src/bin.ts.*daemon" > /dev/null; then
    echo "Worker process not running"
    exit 1
fi

echo "Worker is healthy"
exit 0
