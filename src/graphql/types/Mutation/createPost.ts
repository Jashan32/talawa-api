import type { FileUpload } from "graphql-upload-minimal";
import { ulid } from "ulidx";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { imageMimeTypeEnum } from "~/src/drizzle/enums/imageMimeType";
import { postAttachmentsTable } from "~/src/drizzle/tables/postAttachments";
import { postsTable } from "~/src/drizzle/tables/posts";
import { builder } from "~/src/graphql/builder";
import {
	MutationCreatePostInput,
	mutationCreatePostInputSchema,
} from "~/src/graphql/inputs/MutationCreatePostInput";
import { Post } from "~/src/graphql/types/Post/Post";
import { TalawaGraphQLError } from "~/src/utilities/TalawaGraphQLError";
import { getKeyPathsWithNonUndefinedValues } from "~/src/utilities/getKeyPathsWithNonUndefinedValues";
import envConfig from "~/src/utilities/graphqLimits";
import { isNotNullish } from "~/src/utilities/isNotNullish";
const mutationCreatePostArgumentsSchema = z.object({
	input: mutationCreatePostInputSchema.transform(async (arg, ctx) => {
		let images:
			| (FileUpload & {
					mimetype: z.infer<typeof imageMimeTypeEnum>;
			  })[]
			| null
			| undefined;

		if (isNotNullish(arg.images)) {
			const rawImages = await Promise.all(arg.images);
			const validatedImages: (FileUpload & {
				mimetype: z.infer<typeof imageMimeTypeEnum>;
			})[] = [];

			for (let i = 0; i < rawImages.length; i++) {
				const rawImage = rawImages[i];
				if (rawImage) {
					const { data, success } = imageMimeTypeEnum.safeParse(rawImage.mimetype);

					if (!success) {
						ctx.addIssue({
							code: "custom",
							path: ["images", i],
							message: `Mime type ${rawImage.mimetype} not allowed for image upload.`,
						});
					} else {
						validatedImages.push(
							Object.assign(rawImage, {
								mimetype: data,
							}),
						);
					}
				}
			}

			images = validatedImages;
		} else if (arg.images !== undefined) {
			images = null;
		}

		return {
			...arg,
			images,
		};
	}),
});

builder.mutationField("createPost", (t) =>
	t.field({
		args: {
			input: t.arg({
				description: "",
				required: true,
				type: MutationCreatePostInput,
			}),
		},
		complexity: envConfig.API_GRAPHQL_OBJECT_FIELD_COST,
		description: "Mutation field to create a post.",
		resolve: async (_parent, args, ctx) => {
			if (!ctx.currentClient.isAuthenticated) {
				throw new TalawaGraphQLError({
					extensions: {
						code: "unauthenticated",
					},
				});
			}

			const {
				data: parsedArgs,
				error,
				success,
			} = await mutationCreatePostArgumentsSchema.safeParseAsync(args);

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

			const currentUserId = ctx.currentClient.user.id;

			const [currentUser, existingOrganization] = await Promise.all([
				ctx.drizzleClient.query.usersTable.findFirst({
					columns: {
						role: true,
					},
					where: (fields, operators) => operators.eq(fields.id, currentUserId),
				}),
				ctx.drizzleClient.query.organizationsTable.findFirst({
					columns: {
						countryCode: true,
					},
					with: {
						membershipsWhereOrganization: {
							columns: {
								role: true,
							},
							where: (fields, operators) =>
								operators.eq(fields.memberId, currentUserId),
						},
					},
					where: (fields, operators) =>
						operators.eq(fields.id, parsedArgs.input.organizationId),
				}),
			]);

			if (currentUser === undefined) {
				throw new TalawaGraphQLError({
					extensions: {
						code: "unauthenticated",
					},
				});
			}

			if (existingOrganization === undefined) {
				throw new TalawaGraphQLError({
					extensions: {
						code: "arguments_associated_resources_not_found",
						issues: [
							{
								argumentPath: ["input", "organizationId"],
							},
						],
					},
				});
			}

			if (currentUser.role !== "administrator") {
				const currentUserOrganizationMembership =
					existingOrganization.membershipsWhereOrganization[0];

				if (currentUserOrganizationMembership === undefined) {
					throw new TalawaGraphQLError({
						extensions: {
							code: "unauthorized_action_on_arguments_associated_resources",
							issues: [
								{
									argumentPath: ["input", "organizationId"],
								},
							],
						},
					});
				}

				if (currentUserOrganizationMembership.role !== "administrator") {
					const unauthorizedArgumentPaths = getKeyPathsWithNonUndefinedValues({
						keyPaths: [["input", "isPinned"]],
						object: parsedArgs,
					});

					if (unauthorizedArgumentPaths.length !== 0) {
						throw new TalawaGraphQLError({
							extensions: {
								code: "unauthorized_arguments",
								issues: unauthorizedArgumentPaths.map((argumentPath) => ({
									argumentPath,
								})),
							},
						});
					}
				}
			}

			return await ctx.drizzleClient.transaction(async (tx) => {
				const [createdPost] = await tx
					.insert(postsTable)
					.values({
						creatorId: currentUserId,
						caption: parsedArgs.input.caption,
						pinnedAt:
							parsedArgs.input.isPinned === undefined ||
							parsedArgs.input.isPinned === false
								? undefined
								: new Date(),
						organizationId: parsedArgs.input.organizationId,
					})
					.returning();
				if (createdPost === undefined) {
					ctx.log.error(
						"Postgres insert operation unexpectedly returned an empty array instead of throwing an error.",
					);
					throw new TalawaGraphQLError({
						extensions: {
							code: "unexpected",
						},
					});
				}

				const allAttachments: any[] = [];

				// Handle direct image uploads
				if (isNotNullish(parsedArgs.input.images)) {
					const imageAttachments = [];

					for (const image of parsedArgs.input.images) {
						const objectName = ulid();
						
						// Upload image to MinIO
						await ctx.minio.client.putObject(
							ctx.minio.bucketName,
							objectName,
							image.createReadStream(),
							undefined,
							{
								"content-type": image.mimetype,
							},
						);

						// Create attachment record
						const imageAttachment = {
							creatorId: currentUserId,
							mimeType: image.mimetype,
							id: uuidv7(),
							name: objectName || "uploaded-image",
							postId: createdPost.id,
							objectName: image.filename,
							fileHash: ulid(), // Generate a unique hash for direct uploads
						};

						imageAttachments.push(imageAttachment);
					}

					if (imageAttachments.length > 0) {
						const createdImageAttachments = await tx
							.insert(postAttachmentsTable)
							.values(imageAttachments)
							.returning();

						allAttachments.push(...createdImageAttachments);
					}
				}

				return Object.assign(createdPost, {
					attachments: allAttachments,
				});
			});
		},
		type: Post,
	}),
);
