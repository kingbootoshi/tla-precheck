import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { detectJava, resolveTlcJarPath, TLA_CACHE_DIR, TLA_CACHE_PATH } from "../core/tooling.js";
import { commandText, heading, statusLabel } from "./ui.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "../..");
const SKILL_SOURCE = resolve(PACKAGE_ROOT, "skills/tla-precheck");

const TLC_VERSION = "v1.8.0";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 = "a89d5ef05d1abddab6acfda1dbace14e2e45e7960527ac186dd19c170a955080";

interface SetupTarget {
  name: string;
  skillDir: string;
  detected: boolean;
}

const ask = async (question: string, defaultYes = true): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? "(Y/n)" : "(y/N)";
  const answer = await rl.question(`  ${question} ${suffix} `);
  rl.close();
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
};

const downloadTlc = async (): Promise<string> => {
  console.log(`  Downloading TLC ${TLC_VERSION}...`);
  const response = await fetch(TLC_URL);
  if (!response.ok) {
    throw new Error(`Failed to download TLC: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const hash = createHash("sha256").update(buffer).digest("hex");
  if (hash !== TLC_SHA256) {
    throw new Error(`TLC checksum mismatch: expected ${TLC_SHA256}, got ${hash}`);
  }

  await mkdir(TLA_CACHE_DIR, { recursive: true });
  await writeFile(TLA_CACHE_PATH, buffer);
  return TLA_CACHE_PATH;
};

const detectTargets = (): SetupTarget[] => {
  const home = homedir();
  return [
    {
      name: "Claude Code",
      skillDir: resolve(home, ".claude/skills/tla-precheck"),
      detected: existsSync(resolve(home, ".claude"))
    },
    {
      name: "Codex",
      skillDir: resolve(home, ".codex/skills/tla-precheck"),
      detected: existsSync(resolve(home, ".codex"))
    }
  ];
};

const installSkill = async (targetDir: string): Promise<void> => {
  await mkdir(targetDir, { recursive: true });
  await cp(SKILL_SOURCE, targetDir, { recursive: true });
};

export const runSetup = async (argv: readonly string[]): Promise<void> => {
  const flags = new Set(argv);
  const claudeOnly = flags.has("--claude");
  const codexOnly = flags.has("--codex");

  console.log(`\n${heading("TLA PreCheck Setup")}\n`);

  // 1. Check environment
  console.log(heading("Environment"));
  const java = detectJava();
  console.log(
    `  ${java.found ? statusLabel("ok") : statusLabel("warn")} Java 17+: ${
      java.found ? `found (v${java.version}) via ${java.command}` : "not found"
    }`
  );

  let tlcPath = resolveTlcJarPath();
  if (tlcPath !== null) {
    console.log(`  ${statusLabel("ok")} TLC jar: ${tlcPath}`);
  } else {
    console.log(`  ${statusLabel("warn")} TLC jar: not found`);
    console.log("");
    const shouldDownload = await ask("Download TLC tla2tools.jar? (~15 MB)");
    if (shouldDownload) {
      tlcPath = await downloadTlc();
      console.log(`  ${statusLabel("ok")} Downloaded TLC to ${tlcPath}`);
    } else {
      console.log(`  ${statusLabel("warn")} Skipped TLC download`);
    }
  }

  if (!java.found) {
    console.log("");
    console.log(`  ${statusLabel("warn")} Java 17+ is required for check and build.`);
    console.log("  TLA PreCheck needs any Java 17+ runtime.");
    console.log(`  macOS quick fix: ${commandText("brew install --cask temurin@21")}`);
    console.log("  Temurin is the Eclipse Adoptium OpenJDK distribution.");
    console.log(`  Then rerun: ${commandText("npx tla-precheck doctor")}`);
  }

  // 2. Detect and install agent skills
  console.log("");
  console.log(heading("Agent targets"));

  if (!existsSync(SKILL_SOURCE)) {
    console.log(`  ${statusLabel("fail")} Skill source not found at ${SKILL_SOURCE}`);
    console.log("  This may mean the package was not installed correctly.");
    process.exitCode = 1;
    return;
  }

  const targets = detectTargets();
  const filteredTargets = targets.filter((target) => {
    if (claudeOnly) return target.name === "Claude Code";
    if (codexOnly) return target.name === "Codex";
    return true;
  });

  const detected = filteredTargets.filter((target) => target.detected);
  const notDetected = filteredTargets.filter((target) => !target.detected);

  if (detected.length === 0 && notDetected.length > 0) {
    for (const target of notDetected) {
      console.log(`  ${statusLabel("warn")} ${target.name}: not detected`);
    }
    console.log("");
    const shouldCreate = await ask("No agent directories detected. Create them and install?");
    if (shouldCreate) {
      for (const target of notDetected) {
        await installSkill(target.skillDir);
        console.log(`  ${statusLabel("ok")} Installed: ${target.skillDir}/SKILL.md`);
      }
    }
  } else {
    for (const target of detected) {
      console.log(`  ${statusLabel("ok")} ${target.name}: detected`);
    }
    for (const target of notDetected) {
      console.log(`  ${statusLabel("warn")} ${target.name}: not detected`);
    }

    console.log("");
    const targetNames = detected.map((target) => target.name).join(" + ");
    const shouldInstall = await ask(`Install skill to ${targetNames}?`);
    if (shouldInstall) {
      for (const target of detected) {
        await installSkill(target.skillDir);
        console.log(`  ${statusLabel("ok")} Installed: ${target.skillDir}/SKILL.md`);
      }
    }

    if (notDetected.length > 0) {
      for (const target of notDetected) {
        const shouldCreate = await ask(`${target.name} not detected. Install anyway?`, false);
        if (shouldCreate) {
          await installSkill(target.skillDir);
          console.log(`  ${statusLabel("ok")} Installed: ${target.skillDir}/SKILL.md`);
        }
      }
    }
  }

  // 3. Summary
  console.log("");
  console.log(heading("Setup complete"));
  if (tlcPath !== null) {
    console.log(`  ${statusLabel("ok")} TLC jar: ${tlcPath}`);
    if (tlcPath === TLA_CACHE_PATH && process.env.TLA2TOOLS_JAR === undefined) {
      console.log(`  ${statusLabel("ok")} Commands will use the cached TLC jar automatically.`);
    }
  }
  console.log("");
  console.log(`  ${statusLabel("step")} Verify the machine setup: ${commandText("npx tla-precheck doctor")}`);
  console.log(`  ${statusLabel("step")} In Claude Code or Codex, invoke the installed skill: ${commandText("/tla-precheck")}`);
  console.log(`  ${statusLabel("step")} Or manually, in your codebase, start a machine: ${commandText("npx tla-precheck init")}`);
  console.log("  When prompted, enter any machine name or path. Example: billing");
  console.log(`  ${statusLabel("step")} Then verify the design: ${commandText("npx tla-precheck check billing")}`);
  console.log("");
};
