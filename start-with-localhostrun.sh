#!/bin/bash

# Script to start Claude Code Proxy with localhost.run tunnel
# Works perfectly on Termux - no cloudflared needed!
# Uses SSH tunnel instead - simpler and more reliable

echo "======================================="
echo "Claude Code Proxy + localhost.run"
echo "======================================="
echo ""

# Color codes for better output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed!${NC}"
    echo ""
    echo "Please install Node.js first:"
    echo "  On Termux: pkg install nodejs-lts"
    echo "  On Linux/Mac: https://nodejs.org/"
    exit 1
fi

# Check if SSH is installed (should be by default on Termux)
if ! command -v ssh &> /dev/null; then
    echo -e "${RED}Error: SSH is not installed!${NC}"
    echo ""
    echo "Please install SSH first:"
    echo "  On Termux: pkg install openssh"
    exit 1
fi

# Function to cleanup background processes on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down services...${NC}"
    if [ ! -z "$PROXY_PID" ]; then
        kill $PROXY_PID 2>/dev/null
        echo -e "${GREEN}✓ Proxy stopped${NC}"
    fi
    if [ ! -z "$TUNNEL_PID" ]; then
        kill $TUNNEL_PID 2>/dev/null
        echo -e "${GREEN}✓ Tunnel stopped${NC}"
    fi
    exit 0
}

# Set up trap to cleanup on Ctrl+C
trap cleanup SIGINT SIGTERM

echo -e "${GREEN}Starting Claude Code Proxy...${NC}"
# Start the proxy in the background
node server/server.js &
PROXY_PID=$!

# Wait a bit for the proxy to start
sleep 3

# Check if proxy started successfully
if ! kill -0 $PROXY_PID 2>/dev/null; then
    echo -e "${RED}Error: Failed to start proxy${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Proxy running on http://localhost:42069${NC}"
echo ""

# Start localhost.run tunnel
echo -e "${GREEN}Starting localhost.run tunnel...${NC}"
echo -e "${BLUE}ℹ This will create a temporary public URL${NC}"
echo -e "${BLUE}ℹ The URL will be displayed below - it changes each time${NC}"
echo ""

# Use SSH to create tunnel via localhost.run
# The URL will be printed to stdout
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=60 -R 80:localhost:42069 nokey@localhost.run &
TUNNEL_PID=$!

# Wait a bit for tunnel to establish
sleep 5

# Check if tunnel started successfully
if ! kill -0 $TUNNEL_PID 2>/dev/null; then
    echo -e "${RED}Error: Failed to start tunnel${NC}"
    echo -e "${YELLOW}This might happen if:${NC}"
    echo "  - You're behind a strict firewall"
    echo "  - SSH port 22 is blocked"
    echo "  - localhost.run is temporarily down"
    kill $PROXY_PID 2>/dev/null
    exit 1
fi

echo ""
echo -e "${GREEN}✓ Tunnel established${NC}"
echo ""
echo "======================================="
echo -e "${GREEN}Services are running!${NC}"
echo "======================================="
echo ""
echo -e "${YELLOW}Your public URL is shown above${NC}"
echo -e "${YELLOW}Look for a line like: https://xxxxx.lhr.life${NC}"
echo ""
echo -e "${BLUE}Usage:${NC}"
echo "  - Copy the URL from above"
echo "  - Use it as your API endpoint: <URL>/v1"
echo "  - Example: https://xxxxx.lhr.life/v1"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Wait for both processes
wait $PROXY_PID $TUNNEL_PID
