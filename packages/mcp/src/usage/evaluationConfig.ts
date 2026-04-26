import { loadPricing } from "./pricing.js";

export type EvaluationConfig =
  | { status: "disabled" }
  | { status: "invalid"; message: string }
  | {
    status: "enabled";
    evaluationModel: string;
    evaluationEncoding?: string;
    inputPricePerMillion: number;
    outputPricePerMillion: number;
  };

export async function resolveEvaluationConfig(args: {
  repoPath: string;
  generateEvaluation?: boolean;
  evaluationModel?: string;
  evaluationEncoding?: string;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}): Promise<EvaluationConfig> {
  if (args.generateEvaluation === false) {
    return { status: "disabled" };
  }

  let pricing;
  try {
    pricing = await loadPricing(args.repoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "invalid",
      message: `Evaluation was requested, but pricing configuration is invalid: ${message}`
    };
  }

  const evaluationModel = args.evaluationModel ?? pricing.model;
  const inputPricePerMillion = args.inputPricePerMillion ?? pricing.input_per_million;
  const outputPricePerMillion = args.outputPricePerMillion ?? pricing.output_per_million;
  const evaluationEncoding = args.evaluationEncoding ?? (!args.evaluationModel ? pricing.evaluation_encoding : undefined);

  if (!evaluationModel) {
    return {
      status: "invalid",
      message: "Evaluation was requested, but evaluationModel is missing."
    };
  }

  if (inputPricePerMillion === undefined || outputPricePerMillion === undefined) {
    return {
      status: "invalid",
      message: "Evaluation was requested, but both inputPricePerMillion and outputPricePerMillion are required."
    };
  }

  return {
    status: "enabled",
    evaluationModel,
    ...(evaluationEncoding ? { evaluationEncoding } : {}),
    inputPricePerMillion,
    outputPricePerMillion
  };
}
