import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import * as process from "process";
import getCacheKeyFunction from "@jest/create-cache-key-function";
import type { Transformer, TransformOptions } from "@jest/transform";
import { parse as parseJsonC } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import {
    transformSync,
    transform,
    Options,
    version as swcVersion,
} from "@swc/core";
import { version } from "./package.json";

function createTransformer(
    swcTransformOpts?: Options & {
        experimental?: {
            customCoverageInstrumentation?: {
                enabled: boolean;
                coverageVariable?: string;
                compact?: boolean;
                reportLogic?: boolean;
                ignoreClassMethods?: Array<string>;
                instrumentLog?: { level: string; enableTrace: boolean };
            };
        };
    }
): Transformer {
    const computedSwcOptions = buildSwcTransformOpts(swcTransformOpts);

    const cacheKeyFunction = getCacheKeyFunction(
        [],
        [swcVersion, version, JSON.stringify(computedSwcOptions)]
    );
    const { enabled: canInstrument, ...instrumentOptions } =
        swcTransformOpts?.experimental?.customCoverageInstrumentation ?? {};
    return {
        canInstrument: !!canInstrument, // Tell jest we'll instrument by our own
        process(src, filename, jestOptions) {
            // Determine if we actually instrument codes if jest runs with --coverage
            const swcOptionsForProcess = insertInstrumentationOptions(
                jestOptions,
                !!canInstrument,
                computedSwcOptions,
                instrumentOptions
            );

            return transformSync(src, {
                ...swcOptionsForProcess,
                module: {
                    ...swcOptionsForProcess.module,
                    type: jestOptions.supportsStaticESM
                        ? "es6"
                        : ("commonjs" as any),
                },
                filename,
            });
        },
        processAsync(src, filename, jestOptions) {
            const swcOptionsForProcess = insertInstrumentationOptions(
                jestOptions,
                !!canInstrument,
                computedSwcOptions,
                instrumentOptions
            );

            return transform(src, {
                ...swcOptionsForProcess,
                module: {
                    ...swcOptionsForProcess.module,
                    // async transform is always ESM
                    type: "es6" as any,
                },
                filename,
            });
        },

        getCacheKey(src, filename, ...rest) {
            const baseCacheKey = cacheKeyFunction(src, filename, ...rest);

            const options: TransformOptions =
                typeof rest[0] === "string" ? (rest as any)[1] : rest[0];

            return crypto
                .createHash("sha1")
                .update(baseCacheKey)
                .update("\0", "utf8")
                .update(
                    JSON.stringify({
                        supportsStaticESM: options.supportsStaticESM,
                    })
                )
                .digest("hex");
        },
    };
}

export = { createTransformer };

function getOptionsFromSwrc(): Options {
    const swcrc = path.join(process.cwd(), ".swcrc");
    if (fs.existsSync(swcrc)) {
        const errors = [] as ParseError[];
        const options = parseJsonC(fs.readFileSync(swcrc, "utf-8"), errors);

        if (errors.length > 0) {
            throw new Error(`Error parsing ${swcrc}: ${errors.join(", ")}`);
        }

        return options as Options;
    }
    return {};
}

function buildSwcTransformOpts(
    swcOptions: (Options & { experimental?: unknown }) | undefined
): Options {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { experimental, ...computedSwcOptions } =
        swcOptions && Object.keys(swcOptions).length > 0
            ? swcOptions
            : (getOptionsFromSwrc() as Options & { experimental?: unknown });

    if (!computedSwcOptions.env && !computedSwcOptions.jsc?.target) {
        set(computedSwcOptions, "jsc.target", nodeTarget());
    }

    set(computedSwcOptions, "jsc.transform.hidden.jest", true);

    if (!computedSwcOptions.sourceMaps) {
        set(computedSwcOptions, "sourceMaps", "inline");
    }

    if (computedSwcOptions.jsc?.baseUrl) {
        set(
            computedSwcOptions,
            "jsc.baseUrl",
            path.resolve(computedSwcOptions.jsc.baseUrl)
        );
    }

    return computedSwcOptions;
}

// Ordered list of which target a node version should use.
// Each entry is the lowest version that can use that target.
const nodeTargetDefaults = [
    [18, "es2023"],
    [17, "es2022"],
    [15, "es2021"],
    [14, "es2020"],
    [13, "es2019"],
] as const;

function nodeTarget() {
    const match = process.version.match(/v(\d+)/);
    if (match == null)
        throw Error(`Could not parse major version from ${process.version}`);
    const majorVersion = parseInt(match[1]);
    return (
        nodeTargetDefaults.find(
            ([minVersion]) => majorVersion >= minVersion
        )?.[1] || "es2018"
    );
}

function insertInstrumentationOptions(
    jestOptions: TransformOptions<unknown>,
    canInstrument: boolean,
    swcTransformOpts: Options,
    instrumentOptions?: any
): Options {
    const shouldInstrument = jestOptions.instrument && canInstrument;

    if (!shouldInstrument) {
        return swcTransformOpts;
    }

    if (
        swcTransformOpts?.jsc?.experimental?.plugins?.some(
            (x) => x[0] === "swc-plugin-coverage-instrument"
        )
    ) {
        return swcTransformOpts;
    }

    return {
        ...swcTransformOpts,
        jsc: {
            ...(swcTransformOpts?.jsc ?? {}),
            experimental: {
                ...(swcTransformOpts?.jsc?.experimental ?? {}),
                plugins: [
                    ...(swcTransformOpts?.jsc?.experimental?.plugins ?? []),
                    ["swc-plugin-coverage-instrument", instrumentOptions ?? {}],
                ],
            },
        },
    };
}

function set(obj: any, path: string, value: any) {
    let o = obj;
    const parents = path.split(".");
    const key = parents.pop() as string;

    for (const prop of parents) {
        if (o[prop] == null) o[prop] = {};
        o = o[prop];
    }

    o[key] = value;
}
