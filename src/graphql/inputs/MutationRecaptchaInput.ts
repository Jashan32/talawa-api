import { z } from "zod";
import { builder } from "~/src/graphql/builder";

export const mutationRecaptchaInputSchema = z.object({
	recaptchaToken: z.string().min(1, "Recaptcha token is required"),
});

export const MutationRecaptchaInput = builder
	.inputRef<z.infer<typeof mutationRecaptchaInputSchema>>(
		"MutationRecaptchaInput",
	)
	.implement({
		description: "Input for reCAPTCHA verification mutation.",
		fields: (t) => ({
			recaptchaToken: t.string({
				description: "The reCAPTCHA token to verify.",
				required: true,
			}),
		}),
	});