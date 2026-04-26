#!/usr/bin/env tsx

import fs from "node:fs/promises";
import path from "node:path";

import {
  loadPricing,
  loadPricingCatalog,
  resolvePricingConfig,
  type PricingCatalogProfile,
  type PricingConfig
} from "../packages/mcp/src/usage/pricing.js";

type CliOptions = {
  repoPath: string;
  list: boolean;
  show: boolean;
  profile?: string;
  model?: string;
  evaluationEncoding?: string;
  inputPricePerMillion?: number;
  cachedInputPricePerMillion?: number;
  outputPricePerMillion?: number;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.list) {
    const profiles = await loadPricingCatalog();
    process.stdout.write(renderProfiles(profiles));
    return;
  }

  if (options.show) {
    const pricing = await loadPricing(options.repoPath);
    process.stdout.write(`${JSON.stringify(pricing, null, 2)}\n`);
    return;
  }

  const config = pricingConfigFromOptions(options);
  const resolvedPricing = await resolvePricingConfig(config);
  const pricingDir = path.join(options.repoPath, ".bugcapsule");
  const pricingPath = path.join(pricingDir, "pricing.json");

  await fs.mkdir(pricingDir, { recursive: true });
  await fs.writeFile(pricingPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  process.stdout.write(`Wrote ${pricingPath}\n`);
  process.stdout.write(`${JSON.stringify(resolvedPricing, null, 2)}\n`);
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = normalizeArgName(rawKey ?? "");

    if (key === "list" || key === "show") {
      flags.add(key);
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    values.set(key, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const options: CliOptions = {
    repoPath: path.resolve(values.get("repo") ?? values.get("repoPath") ?? requiredRepoPath(flags)),
    list: flags.has("list"),
    show: flags.has("show")
  };

  const profile = values.get("profile") ?? positional[0];
  const model = values.get("model");
  const evaluationEncoding = values.get("evaluationEncoding");

  if (positional.length > 1) {
    throw new Error(`Unexpected positional argument: ${positional[1]}`);
  }

  if (profile) {
    options.profile = profile;
  }
  if (model) {
    options.model = model;
  }
  if (evaluationEncoding) {
    options.evaluationEncoding = evaluationEncoding;
  }

  Object.assign(
    options,
    optionalNumber("inputPricePerMillion", values, "inputPricePerMillion"),
    optionalNumber("cachedInputPricePerMillion", values, "cachedInputPricePerMillion"),
    optionalNumber("outputPricePerMillion", values, "outputPricePerMillion")
  );

  return options;
}

function pricingConfigFromOptions(options: CliOptions): PricingConfig {
  if (!options.profile && !options.model) {
    printUsageAndExit(1);
  }

  if (!options.profile && (options.inputPricePerMillion === undefined || options.outputPricePerMillion === undefined)) {
    throw new Error("Manual pricing requires --input-price-per-million and --output-price-per-million.");
  }

  return {
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.evaluationEncoding ? { evaluation_encoding: options.evaluationEncoding } : {}),
    ...(options.inputPricePerMillion !== undefined ? { input_per_million: options.inputPricePerMillion } : {}),
    ...(options.cachedInputPricePerMillion !== undefined ? { cached_input_per_million: options.cachedInputPricePerMillion } : {}),
    ...(options.outputPricePerMillion !== undefined ? { output_per_million: options.outputPricePerMillion } : {})
  };
}

function renderProfiles(profiles: PricingCatalogProfile[]): string {
  const lines = [
    "Available BugCapsule pricing profiles:",
    "",
    "Profile | Model | Input/M | Cached input/M | Output/M | Notes",
    "--- | --- | ---: | ---: | ---: | ---"
  ];

  for (const profile of profiles) {
    lines.push([
      profile.id,
      profile.displayName ?? profile.model,
      price(profile.input_per_million),
      price(profile.cached_input_per_million),
      price(profile.output_per_million),
      profile.requiresManualPrice ? "requires manual prices" : profile.notes ?? ""
    ].join(" | "));
  }

  lines.push("");
  return lines.join("\n");
}

function optionalNumber(
  key: "inputPricePerMillion" | "cachedInputPricePerMillion" | "outputPricePerMillion",
  values: Map<string, string>,
  property: keyof Pick<CliOptions, "inputPricePerMillion" | "cachedInputPricePerMillion" | "outputPricePerMillion">
): Partial<CliOptions> {
  const value = values.get(key);
  if (value === undefined) {
    return {};
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number for --${kebabCase(key)}, received: ${value}`);
  }

  return { [property]: parsed };
}

function price(value: number | undefined): string {
  return value === undefined ? "-" : `$${value}`;
}

function normalizeArgName(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function printUsageAndExit(code: number): never {
  const usage = `Usage:
  npm run pricing -- --list
  npm run pricing -- --repo <repoPath> --profile windsurf:swe-1.6-fast
  npm run pricing -- --repo <repoPath> --model <name> --input-price-per-million <usd> --output-price-per-million <usd>

Options:
  --repo <path>                         Repository to configure.
  --list                                Print bundled pricing profiles.
  --show                                Print the resolved pricing for the repo.
  --profile <id>                        Use a bundled profile, for example windsurf:swe-1.6-fast.
  --model <name>                        Manual model name.
  --evaluation-encoding <name>           Tokenizer encoding proxy, for example o200k_base.
  --input-price-per-million <usd>        Manual or override input token price.
  --cached-input-price-per-million <usd> Optional cached input token price.
  --output-price-per-million <usd>       Manual or override output token price.
`;
  process.stderr.write(usage);
  process.exit(code);
}

function requiredRepoPath(flags: Set<string>): string {
  if (flags.has("list")) {
    return ".";
  }

  throw new Error("Missing --repo <path>.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`BugCapsule pricing configuration failed: ${message}\n`);
  process.exit(1);
});
