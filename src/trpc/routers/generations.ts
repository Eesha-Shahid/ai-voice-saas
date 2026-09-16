import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { chatterbox } from "@/lib/chatterbox-client";
import { prisma } from "@/lib/db";
import { uploadAudio } from "@/lib/r2";
import { TEXT_MAX_LENGTH } from "@/features/text-to-speech/data/constants";
import { createTRPCRouter, orgProcedure } from "../init";
import { or, and } from "@prisma/orm-postgres/orm-client";

export const generationsRouter = createTRPCRouter({
  getById: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const generation = await prisma.orm.public.Generation
        .where({ id: input.id, orgId: ctx.orgId })
        .first();

      if (!generation) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { orgId, r2ObjectKey, ...rest } = generation;

      return {
        ...rest,
        audioUrl: `/api/audio/${generation.id}`,
      };
    }),

  getAll: orgProcedure.query(async ({ ctx }) => {
    const generations = await prisma.orm.public.Generation
      .where({ orgId: ctx.orgId })
      .orderBy((gen) => gen.createdAt.desc())
      .all();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return generations.map(({ orgId, r2ObjectKey, ...rest }) => rest);

  }),

  create: orgProcedure
    .input(
      z.object({
        text: z.string().min(1).max(TEXT_MAX_LENGTH),
        voiceId: z.string().min(1),
        temperature: z.number().min(0).max(2).default(0.8),
        topP: z.number().min(0).max(1).default(0.95),
        topK: z.number().min(1).max(10000).default(1000),
        repetitionPenalty: z.number().min(1).max(2).default(1.2),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const voice = await prisma.orm.public.Voice
        .where({ id: input.voiceId })
        .where((v) => or(v.variant.eq("SYSTEM"), and(v.variant.eq("CUSTOM"), v.orgId.eq(ctx.orgId))))
        .select("id", "name", "r2ObjectKey")
        .first();

      if (!voice) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Voice not found" });
      }

      if (!voice.r2ObjectKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Voice audio not available",
        });
      }
      
      Sentry.logger.info("Generation started", {
        orgId: ctx.orgId,
        voiceId: input.voiceId,
        textLength: input.text.length,
      });

      const { data, error } = await chatterbox.POST("/generate", {
        body: {
          prompt: input.text,
          voice_key: voice.r2ObjectKey,
          temperature: input.temperature,
          top_p: input.topP,
          top_k: input.topK,
          repetition_penalty: input.repetitionPenalty,
          norm_loudness: true,
        },
        parseAs: "arrayBuffer",
      });

      if (error) {
        Sentry.logger.error("Chatterbox generation request failed", {
          orgId: ctx.orgId,
          voiceId: input.voiceId,
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate audio",
        });
      }

      if (!(data instanceof ArrayBuffer)) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Invalid audio response",
        });
      }

      const buffer = Buffer.from(data);
      let generationId: string | null = null;
      let r2ObjectKey: string | null = null;

      try {
        const generation = await prisma.orm.public.Generation
          .select("id")
          .create({
            orgId: ctx.orgId,
            text: input.text,
            voiceName: voice.name,
            voiceId: voice.id,
            temperature: input.temperature,
            topP: input.topP,
            topK: input.topK,
            repetitionPenalty: input.repetitionPenalty,
          }
        );

        generationId = generation.id;
        r2ObjectKey = `generations/orgs/${ctx.orgId}/${generation.id}`;
        
        await uploadAudio({ buffer, key: r2ObjectKey });
  
        await prisma.orm.public.Generation
          .where({ id: generation.id })
          .update({ r2ObjectKey });

        Sentry.logger.info("Audio generated", {
          orgId: ctx.orgId,
          generationId: generation.id,
        });
          
      } catch {
        if (generationId) {
          await prisma.orm.public.Generation
            .where({ id: generationId })
            .delete()
            .catch(() => {});
        }

        Sentry.logger.error("Generation failed", {
          orgId: ctx.orgId,
          voiceId: input.voiceId,
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to store generated audio",
        });
      }

      if (!generationId || !r2ObjectKey) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to store generated audio",
        });
      }

      return { id: generationId };
    }),
});