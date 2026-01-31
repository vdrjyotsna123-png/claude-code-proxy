#!/data/data/com.termux/files/usr/bin/bash

# Termux Setup Script for Claude Code Proxy + Cloudflare Tunnel
# This script automates the installation process on Termux

echo "========================================="
echo "Claude Code Proxy - Termux Setup"
echo "========================================="
echo ""

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored messages
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

# Check if running on Termux
if [ ! -d "/data/data/com.termux" ]; then
    print_error "This script is designed for Termux only!"
    exit 1
fi

print_info "Starting setup process..."
echo ""

# Update packages
echo "Step 1: Updating packages..."
pkg update -y && pkg upgrade -y
print_success "Packages updated"
echo ""

# Install Node.js
echo "Step 2: Installing Node.js..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    print_warning "Node.js already installed: $NODE_VERSION"
else
    pkg install -y nodejs-lts
    print_success "Node.js installed"
fi
echo ""

# Install Git
echo "Step 3: Installing Git..."
if command -v git &> /dev/null; then
    GIT_VERSION=$(git --version)
    print_warning "Git already installed: $GIT_VERSION"
else
    pkg install -y git
    print_success "Git installed"
fi
echo ""

# Install wget
echo "Step 4: Installing wget..."
if command -v wget &> /dev/null; then
    print_warning "wget already installed"
else
    pkg install -y wget
    print_success "wget installed"
fi
echo ""

# Install cloudflared
echo "Step 5: Installing Cloudflare Tunnel (cloudflared)..."
if command -v cloudflared &> /dev/null; then
    CLOUDFLARED_VERSION=$(cloudflared --version)
    print_warning "cloudflared already installed: $CLOUDFLARED_VERSION"
    read -p "Do you want to reinstall? (y/n): " REINSTALL
    if [ "$REINSTALL" != "y" ]; then
        print_info "Skipping cloudflared installation"
    else
        rm -f $PREFIX/bin/cloudflared
        wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
        chmod +x cloudflared-linux-arm64
        mv cloudflared-linux-arm64 $PREFIX/bin/cloudflared
        print_success "cloudflared reinstalled"
    fi
else
    print_info "Downloading cloudflared..."
    wget -q --show-progress https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
    chmod +x cloudflared-linux-arm64
    mv cloudflared-linux-arm64 $PREFIX/bin/cloudflared
    print_success "cloudflared installed"
fi
echo ""

# Verify installations
echo "Step 6: Verifying installations..."
echo ""

if command -v node &> /dev/null; then
    print_success "Node.js: $(node --version)"
else
    print_error "Node.js installation failed!"
    exit 1
fi

if command -v npm &> /dev/null; then
    print_success "npm: $(npm --version)"
else
    print_error "npm installation failed!"
    exit 1
fi

if command -v git &> /dev/null; then
    print_success "Git: $(git --version)"
else
    print_error "Git installation failed!"
    exit 1
fi

if command -v cloudflared &> /dev/null; then
    print_success "cloudflared: $(cloudflared --version 2>&1 | head -n1)"
else
    print_error "cloudflared installation failed!"
    exit 1
fi

echo ""
echo "========================================="
print_success "Installation Complete!"
echo "========================================="
echo ""

# Setup instructions
print_info "Next steps:"
echo ""
echo "1. Authenticate with Cloudflare:"
echo "   ${BLUE}cloudflared tunnel login${NC}"
echo "   (Copy the URL and open it in your browser)"
echo ""
echo "2. Create a tunnel:"
echo "   ${BLUE}cloudflared tunnel create claude-proxy${NC}"
echo ""
echo "3. Configure the tunnel (optional, for custom domain):"
echo "   ${BLUE}cp cloudflare-config.yml.example ~/.cloudflared/config.yml${NC}"
echo "   ${BLUE}nano ~/.cloudflared/config.yml${NC}"
echo ""
echo "4. Start the proxy with tunnel:"
echo "   ${BLUE}./start-with-tunnel.sh${NC}"
echo ""
echo "   OR use quick tunnel (no config needed):"
echo "   ${BLUE}./start-with-tunnel.sh${NC}"
echo "   (It will auto-detect and use quick tunnel if no config found)"
echo ""
print_info "For detailed instructions, see: CLOUDFLARE-SETUP.md"
echo ""
