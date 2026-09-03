#!/usr/bin/env npx tsx
import { main } from "../src/cli/main";

void main(process.argv.slice(2)).then((code) => process.exit(code));
