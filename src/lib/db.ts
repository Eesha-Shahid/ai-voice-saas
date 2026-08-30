import "dotenv/config";
import { db as prismaDb } from "@/prisma/db";
import { env } from "./env";

const globalForDb = global as unknown as {
  dbConnected: boolean;
};

if (!globalForDb.dbConnected) {
  await prismaDb.connect({ url: env.DATABASE_URL });
  globalForDb.dbConnected = true;
}

export const db = prismaDb;
