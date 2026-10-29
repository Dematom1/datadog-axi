#!/usr/bin/env node
// Session-start hook entrypoint. Prints the offline context block only:
// it never reads the keychain and never touches the network.
import { runCtxHook } from "../src/commands/ctx.js";

process.stdout.write(runCtxHook());
