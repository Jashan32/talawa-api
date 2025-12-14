import { z } from "zod";
import { builder } from "~/src/graphql/builder";
import {
	MutationRecaptchaInput,
	mutationRecaptchaInputSchema,
} from "~/src/graphql/inputs/MutationRecaptchaInput";
import { TalawaGraphQLError } from "~/src/utilities/TalawaGraphQLError";
import envConfig from "~/src/utilities/graphqLimits";

const mutationRecaptchaArgumentsSchema = z.object({
	data: mutationRecaptchaInputSchema,
});

interface RecaptchaVerificationResponse {
	success: boolean;
	challenge_ts?: string;
	hostname?: string;
	"error-codes"?: string[];
}

/**
 * Verifies a Google reCAPTCHA v2 token by making a request to Google's verification API.
 */
async function verifyRecaptchaToken(
	token: string,
	secretKey: string,
): Promise<boolean> {
	try {
		const verificationUrl = "https://www.google.com/recaptcha/api/siteverify";
		const params = new URLSearchParams({
			secret: secretKey,
			response: token,
		});

		const response = await fetch(verificationUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params,
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const data = await response.json() as RecaptchaVerificationResponse;
		return data.success === true;
	} catch (error) {
		console.error("reCAPTCHA verification error:", error);
		return false;
	}
}

builder.mutationField("recaptcha", (t) =>
	t.field({
		args: {
			data: t.arg({
				description: "Input data for reCAPTCHA verification.",
				required: true,
				type: MutationRecaptchaInput,
			}),
		},
		complexity: envConfig.API_GRAPHQL_MUTATION_BASE_COST,
		description: "Mutation field to verify Google reCAPTCHA v2 token.",
		type: "Boolean",
		resolve: async (_parent, args, ctx) => {
			const {
				data: parsedArgs,
				error,
				success,
			} = mutationRecaptchaArgumentsSchema.safeParse(args);

			if (!success) {
				throw new TalawaGraphQLError({
					extensions: {
						code: "invalid_arguments",
						issues: error.issues.map((issue) => ({
							argumentPath: issue.path,
							message: issue.message,
						})),
					},
				});
			}

			// Access RECAPTCHA_SECRET_KEY from context environment config
			const recaptchaSecretKey = ctx.envConfig.RECAPTCHA_SECRET_KEY;

			// Check if reCAPTCHA is configured
			if (!recaptchaSecretKey) {
				throw new TalawaGraphQLError({
					extensions: {
						code: "forbidden_action",
					},
				});
			}

			try {
				const isValid = await verifyRecaptchaToken(
					parsedArgs.data.recaptchaToken,
					recaptchaSecretKey,
				);

				if (!isValid) {
					throw new TalawaGraphQLError({
						extensions: {
							code: "invalid_arguments",
							issues: [
								{
									argumentPath: ["data", "recaptchaToken"],
									message: "Invalid reCAPTCHA token.",
								},
							],
						},
					});
				}

				return true;
			} catch (error) {
				if (error instanceof TalawaGraphQLError) {
					throw error;
				}

				ctx.log.error("Unexpected error during reCAPTCHA verification:", error);

				throw new TalawaGraphQLError({
					extensions: {
						code: "unexpected",
					},
				});
			}
		},
	}),
);