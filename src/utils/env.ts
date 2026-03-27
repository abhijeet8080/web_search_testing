import dotenv from "dotenv";

dotenv.config();

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. Create a .env file with EXA_API_KEY.`,
    );
  }
  return value;
}

