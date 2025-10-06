import envConfig from "~/src/utilities/graphqLimits";
import { Post } from "./Post";

Post.implement({
	fields: (t) => ({
		attachmentURL: t.field({
			description: "URL to the first image attachment as avatar of the post.",
			// Using API_GRAPHQL_SCALAR_RESOLVER_FIELD_COST despite having a resolver because resolver only does simple logic
			complexity: envConfig.API_GRAPHQL_SCALAR_RESOLVER_FIELD_COST,
			resolve: async (parent, _args, ctx) => {
				// Find the first image attachment to use as avatar
				if (!parent.attachments || parent.attachments.length === 0) {
					return null;
				}

				// Find first image attachment (not video)
				const firstImageAttachment = parent.attachments.find((attachment) =>
					attachment.mimeType.startsWith("image/")
				);

				if (!firstImageAttachment || !firstImageAttachment.name) {
					return null;
				}

				return new URL(
					`/objects/${firstImageAttachment.name}`,
					ctx.envConfig.API_BASE_URL,
				).toString();
			},
			type: "String",
		}),
	}),
});