import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/libsql";
import { db as client } from "../db/client";
import * as authSchema from "../db/auth-schema";

const db = drizzle(client, { schema: authSchema });

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL,
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: authSchema,
  }),
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
    },
  },
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      scope: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
      // Request offline access to get a refresh token
      accessType: "offline",
      // Force consent screen to always get a refresh token (even on re-auth)
      prompt: "consent",
    },
  },
  trustedOrigins: [
    "http://localhost:3000",
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
    process.env.NEXT_PUBLIC_APP_URL || "",
  ].filter(Boolean),
});

export type Session = typeof auth.$Infer.Session;
