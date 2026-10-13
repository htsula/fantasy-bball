import { z } from "zod";

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(32, "Username must be at most 32 characters")
  .regex(/^[A-Za-z0-9_.-]+$/, "Use only letters, numbers, dots, dashes and underscores");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200, "Password is too long");

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Display name is required")
  .max(50, "Display name must be at most 50 characters");

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Enter your username"),
  password: z.string().min(1, "Enter your password"),
});

export const newPasswordSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const inviteRedeemSchema = z
  .object({
    username: usernameSchema,
    displayName: displayNameSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

/** Shape returned by form server actions. */
export type FormState = {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  success?: string;
  /** Echoed back (never passwords) so inputs keep their value after a failed submit. */
  values?: Record<string, string>;
};
