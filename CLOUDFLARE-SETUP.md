# Cloudflare Tunnel Setup Guide

This guide will help you set up Cloudflare Tunnel to expose your Claude Code Proxy to the internet securely.

## Why Use Cloudflare Tunnel?

- **Secure**: No need to open ports on your router
- **Free**: Cloudflare Tunnel is free to use
- **Easy**: Simple setup process
- **HTTPS**: Automatic SSL/TLS encryption
- **Perfect for Termux**: Works great on Android devices

## Prerequisites

- A Cloudflare account (free): https://dash.cloudflare.com/sign-up
- (Optional) A domain registered with Cloudflare

## Installation

### On Termux (Android)

```bash
# Install wget if not already installed
pkg install wget

# Download cloudflared for ARM64
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64

# Make it executable
chmod +x cloudflared-linux-arm64

# Move to PATH
mv cloudflared-linux-arm64 $PREFIX/bin/cloudflared

# Verify installation
cloudflared --version
```

### On Linux/macOS/Windows

Follow the official installation guide:
https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/

## Quick Start (No Domain Required)

The easiest way to get started is using a **quick tunnel**, which gives you a temporary URL:

```bash
# Start the proxy and tunnel together
./start-with-tunnel.sh
```

This will:
1. Start the Claude Code Proxy on port 42069
2. Create a temporary Cloudflare tunnel
3. Give you a URL like: `https://random-words.trycloudflare.com`

**Note**: Quick tunnels are temporary and the URL changes each time you restart.

## Full Setup (With Custom Domain)

If you want a permanent URL with your own domain:

### Step 1: Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

**In Termux**: Since there's no GUI browser, you'll see a URL. Copy it and open it in your phone's browser to authenticate.

This saves a certificate to `~/.cloudflared/cert.pem`

### Step 2: Create a Tunnel

```bash
# Create a named tunnel
cloudflared tunnel create claude-proxy
```

Save the **Tunnel ID** that appears - you'll need it!

### Step 3: Configure the Tunnel

```bash
# Create config directory
mkdir -p ~/.cloudflared

# Copy the example config
cp cloudflare-config.yml.example ~/.cloudflared/config.yml

# Edit the config
nano ~/.cloudflared/config.yml
```

Update these values in the config:
- Replace `YOUR-TUNNEL-ID-HERE` with your actual Tunnel ID (in 2 places)
- Replace `your-subdomain.yourdomain.com` with your desired domain

Example config:
```yaml
tunnel: 8e7a9b2c-1d3e-4f5a-6b7c-8d9e0f1a2b3c
credentials-file: /data/data/com.termux/files/home/.cloudflared/8e7a9b2c-1d3e-4f5a-6b7c-8d9e0f1a2b3c.json

ingress:
  - hostname: claude-proxy.yourdomain.com
    service: http://localhost:42069
  - service: http_status:404
```

**Note for non-Termux systems**: Change the credentials path to match your system:
- Linux/macOS: `/home/yourusername/.cloudflared/YOUR-TUNNEL-ID.json`
- Windows: `C:\Users\yourusername\.cloudflared\YOUR-TUNNEL-ID.json`

### Step 4: Route DNS

```bash
# Route your domain to the tunnel
cloudflared tunnel route dns claude-proxy claude-proxy.yourdomain.com
```

Replace `claude-proxy.yourdomain.com` with your actual domain.

### Step 5: Start Everything

```bash
./start-with-tunnel.sh
```

Your proxy will now be accessible at `https://claude-proxy.yourdomain.com`!

## Running as a Service (Auto-start)

### On Termux with Termux:Boot

1. Install Termux:Boot from F-Droid
2. Create a startup script:

```bash
mkdir -p ~/.termux/boot
nano ~/.termux/boot/start-claude-proxy.sh
```

Add:
```bash
#!/data/data/com.termux/files/usr/bin/bash
cd ~/claude-code-proxy
./start-with-tunnel.sh > ~/claude-proxy.log 2>&1 &
```

Make it executable:
```bash
chmod +x ~/.termux/boot/start-claude-proxy.sh
```

Now it will start automatically when your device boots!

### On Linux (systemd)

Create a service file:
```bash
sudo nano /etc/systemd/system/claude-proxy.service
```

Add:
```ini
[Unit]
Description=Claude Code Proxy with Cloudflare Tunnel
After=network.target

[Service]
Type=simple
User=yourusername
WorkingDirectory=/path/to/claude-code-proxy
ExecStart=/path/to/claude-code-proxy/start-with-tunnel.sh
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable claude-proxy
sudo systemctl start claude-proxy
sudo systemctl status claude-proxy
```

## Troubleshooting

### "cloudflared: command not found"
- Make sure you completed the installation steps
- On Termux, verify with: `which cloudflared`
- Try reinstalling following the steps above

### Authentication not working in Termux
- Copy the URL shown after `cloudflared tunnel login`
- Paste it in your phone's browser
- Complete the authentication there

### Tunnel won't start
- Check if port 42069 is already in use: `lsof -i :42069` (or `netstat -an | grep 42069`)
- Verify your config file exists: `cat ~/.cloudflared/config.yml`
- Check logs: `cloudflared tunnel run` (run manually to see errors)

### Connection refused errors
- Make sure the proxy is running first before starting the tunnel
- Check proxy is accessible locally: `curl http://localhost:42069`

### Quick tunnel URL not showing
- Wait a few seconds after startup
- Check for errors in the output
- Try running manually: `cloudflared tunnel --url http://localhost:42069`

## Security Notes

- The quick tunnel URLs are public and temporary - don't share sensitive data
- For production use, use authenticated tunnels with your own domain
- Consider adding Cloudflare Access for additional authentication
- Keep your credentials file (`~/.cloudflared/*.json`) secure and private

## Additional Resources

- [Cloudflare Tunnel Documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
- [Cloudflare Access (Authentication)](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/)
- [Termux Documentation](https://wiki.termux.com/)

## Support

For issues specific to:
- **Claude Code Proxy**: See main README.md
- **Cloudflare Tunnel**: Visit Cloudflare Community Forums
- **Termux**: Visit r/termux or Termux wiki
