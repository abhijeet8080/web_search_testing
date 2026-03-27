import { Exa } from "exa-js";
import { requiredEnv } from "./utils/env.js";

export const exa = new Exa(requiredEnv("EXA_API_KEY"));

