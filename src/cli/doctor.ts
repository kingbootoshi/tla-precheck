import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { detectJava, resolveTlcJarPath } from "../core/tooling.js";
import { heading, statusLabel } from "./ui.js";

interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const checkJava = (): DoctorCheck => {
  const java = detectJava();
  if (!java.found) {
    return { name: "Java", status: "fail", detail: "not found - required for TLC model checking" };
  }
  const majorVersion = Number.parseInt(java.version, 10);
  if (majorVersion < 17) {
    return { name: "Java", status: "warn", detail: `v${java.version} via ${java.command} (17+ recommended)` };
  }
  return { name: "Java", status: "ok", detail: `v${java.version} via ${java.command}` };
};

const checkTlc = (): DoctorCheck => {
  const envJar = process.env.TLA2TOOLS_JAR;
  if (envJar !== undefined && envJar.length > 0) {
    if (existsSync(envJar)) {
      return { name: "TLC jar", status: "ok", detail: envJar };
    }
    return { name: "TLC jar", status: "fail", detail: `TLA2TOOLS_JAR set but file missing: ${envJar}` };
  }

  const cachedJar = resolveTlcJarPath();
  if (cachedJar !== null) {
    return { name: "TLC jar", status: "ok", detail: `${cachedJar} (cached fallback)` };
  }

  return { name: "TLC jar", status: "fail", detail: "not found - run 'tla-precheck setup' to install" };
};

const checkAgentSkill = (name: string, baseDir: string, skillDir: string): DoctorCheck => {
  const skillFile = resolve(skillDir, "SKILL.md");
  if (existsSync(skillFile)) {
    return { name: `${name} skill`, status: "ok", detail: skillDir };
  }
  if (existsSync(baseDir)) {
    return { name: `${name} skill`, status: "warn", detail: `agent dir exists but skill not installed` };
  }
  return { name: `${name} skill`, status: "warn", detail: "agent dir not detected" };
};

export const runDoctor = async (): Promise<void> => {
  console.log(`\n${heading("TLA PreCheck Doctor")}\n`);

  const home = homedir();
  const checks: DoctorCheck[] = [
    checkJava(),
    checkTlc(),
    checkAgentSkill(
      "Claude Code",
      resolve(home, ".claude"),
      resolve(home, ".claude/skills/tla-precheck")
    ),
    checkAgentSkill(
      "Codex",
      resolve(home, ".codex"),
      resolve(home, ".codex/skills/tla-precheck")
    )
  ];

  for (const check of checks) {
    console.log(`  ${statusLabel(check.status)} ${check.name}: ${check.detail}`);
  }

  const failures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");

  console.log("");
  if (failures.length > 0) {
    console.log(
      `${statusLabel("fail")} ${failures.length} issue(s) need attention. Run 'tla-precheck setup' to fix them.`
    );
    process.exitCode = 1;
  } else if (warnings.length > 0) {
    console.log(
      `${statusLabel("warn")} All critical checks pass. ${warnings.length} warning(s) still need attention.`
    );
  } else {
    console.log(`${statusLabel("ok")} All checks pass. Ready to go.`);
  }
  console.log("");
};
