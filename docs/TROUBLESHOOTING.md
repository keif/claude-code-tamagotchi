# Troubleshooting Guide 🔨

## Common Issues

### Pet not showing up?
- Restart Claude Code
- Check `~/.claude/settings.json` has the right statusline configuration
- Make sure setup.sh completed successfully

### Commands not working?
- Check if files exist in `~/.claude/commands/`
- Verify Bun is installed: `bun --version`
- Try running setup.sh again

### Pet seems frozen?
- They only update during active conversations
- Try typing something to wake them up!

## Node.js v23 TypeScript Error

If you installed with npm and get this error when running `claude-code-tamagotchi statusline`:
```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules
```

This happens because Node.js v23's native TypeScript support doesn't work with files inside `node_modules`. 

**Solution:** Use Bun instead of npm for global installation:
```bash
# Uninstall from npm
npm uninstall -g claude-code-tamagotchi

# Install with Bun (handles TypeScript everywhere)
bun add -g claude-code-tamagotchi
```

Alternatively, install from source or use nvm which may handle the package structure differently.

## Violation Detection Issues

### Too many false positives?
If the violation detection is too sensitive:
```bash
# Temporarily disable for current session
export PET_VIOLATION_CHECK_ENABLED=false

# Or permanently in your shell profile
echo 'export PET_VIOLATION_CHECK_ENABLED=false' >> ~/.zshrc
```

### Violations not being detected?
- Ensure the pre-hook is installed in `~/.claude/settings.json`
- Check that `PET_VIOLATION_CHECK_ENABLED=true`
- Verify the command works: `bunx claude-code-tamagotchi violation-check`

### Debug mode for violations
Enable detailed logging to troubleshoot:
```bash
export PET_FEEDBACK_DEBUG=true
export PET_FEEDBACK_LOG_DIR="~/.claude/pets/logs"
```

## Uninstalling 😢

If you need to say goodbye to your pet (we'll miss you!):

```bash
# 1. Remove the pet commands
rm -f ~/.claude/commands/pet-*.md

# 2. Remove your pet's data (optional - keeps your pet's memory)
rm -f ~/.claude/pets/*.json

# 3. Update your Claude Code settings to remove the statusline
# Edit ~/.claude/settings.json and remove/change the "statusLine" entry

# 4. Remove any environment variables from your shell profile
# Edit ~/.bashrc or ~/.zshrc and remove any PET_* exports

# 5. Delete the cloned repository (optional)
# rm -rf /path/to/claude-code-tamagotchi
```

That's it! Your pet will be waiting if you ever want to reinstall.

## Still Having Issues?

Please [open an issue](https://github.com/Ido-Levi/claude-code-tamagotchi/issues) with:
- Your operating system
- Bun version (`bun --version`)
- Claude Code version
- The error message you're seeing
- Steps to reproduce the problem