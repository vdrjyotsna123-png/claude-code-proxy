#!/bin/bash

# Script to start Claude Code Proxy with Cloudflare Tunnel
# Works on Linux, macOS, and Termux

echo "================================"
echo "Claude Code Proxy + Cloudflare"
echo "================================"
echo ""

# Color codes for better output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Detect if running on Termux
IS_TERMUX=false
if [ -d "/data/data/com.termux" ]; then
    IS_TERMUX=true
    echo -e "${YELLOW}ℹ Detected Termux environment${NC}"
    echo ""
fi

# Fix DNS and IPv6 issues on Termux
if [ "$IS_TERMUX" = true ]; then
    # Set environment variables to fix DNS resolution
    export GODEBUG=netdns=go
    export ANDROID_DNS_MODE=local

    # Ensure DNS is properly configured
    if [ ! -f "$PREFIX/etc/resolv.conf" ] || [ ! -s "$PREFIX/etc/resolv.conf" ]; then
        echo -e "${YELLOW}Configuring DNS...${NC}"
        echo "nameserver 8.8.8.8" > $PREFIX/etc/resolv.conf
        echo "nameserver 1.1.1.1" >> $PREFIX/etc/resolv.conf
        echo -e "${GREEN}✓ DNS configured${NC}"
        echo ""
    fi
fi

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo -e "${RED}Error: cloudflared is not installed!${NC}"
    echo ""
    echo "Please install cloudflared first:"
    echo "  On Termux: See CLOUDFLARE-SETUP.md"
    echo "  On Linux/Mac: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
    exit 1
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed!${NC}"
    echo ""
    echo "Please install Node.js first:"
    echo "  On Termux: pkg install nodejs-lts"
    echo "  On Linux/Mac: https://nodejs.org/"
    exit 1
fi

# Check if config file exists
CLOUDFLARE_CONFIG="$HOME/.cloudflared/config.yml"
if [ ! -f "$CLOUDFLARE_CONFIG" ]; then
    echo -e "${YELLOW}Warning: Cloudflare config not found at $CLOUDFLARE_CONFIG${NC}"
    echo ""
    echo "Using quick tunnel mode (no authentication required)"
    echo "This will generate a temporary URL like: https://random-words.trycloudflare.com"
    echo ""
    USE_QUICK_TUNNEL=true
else
    echo -e "${GREEN}✓ Found Cloudflare config${NC}"
    USE_QUICK_TUNNEL=false
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

# Start Cloudflare tunnel
echo -e "${GREEN}Starting Cloudflare Tunnel...${NC}"

if [ "$USE_QUICK_TUNNEL" = true ]; then
    echo -e "${YELLOW}Using quick tunnel (temporary URL)${NC}"
    # Use 127.0.0.1 instead of localhost to force IPv4 (fixes Termux IPv6 issues)
    if [ "$IS_TERMUX" = true ]; then
        cloudflared tunnel --url http://127.0.0.1:42069 --protocol http2 &
    else
        cloudflared tunnel --url http://localhost:42069 &
    fi
    TUNNEL_PID=$!
else
    echo -e "${GREEN}Using configured tunnel${NC}"
    cloudflared tunnel run &
    TUNNEL_PID=$!
fi

# Wait a bit for tunnel to establish
sleep 3

# Check if tunnel started successfully
if ! kill -0 $TUNNEL_PID 2>/dev/null; then
    echo -e "${RED}Error: Failed to start tunnel${NC}"
    kill $PROXY_PID 2>/dev/null
    exit 1
fi

echo -e "${GREEN}✓ Tunnel established${NC}"
echo ""
echo "================================"
echo -e "${GREEN}Services are running!${NC}"
echo "================================"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Wait for both processes
wait $PROXY_PID $TUNNEL_PID
