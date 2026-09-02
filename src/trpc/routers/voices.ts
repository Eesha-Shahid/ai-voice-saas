import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { deleteAudio } from "@/lib/r2";
import { createTRPCRouter, orgProcedure } from "../init";
import { or } from "@prisma/orm-postgres/orm-client";
import { VoiceCategory } from "@/features/voices/data/voice-categories";

export interface VoiceListItem {
  id: string;
  name: string;
  description: string | null;
  category: VoiceCategory;
  language: string;
  variant: "SYSTEM" | "CUSTOM";
}

export const voicesRouter = createTRPCRouter({
  getAll: orgProcedure
    .input(
      z
        .object({
          query: z.string().trim().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }): Promise<{ custom: VoiceListItem[]; system: VoiceListItem[] }> => {
      const q = input?.query;

      const customQuery = q
        ? db.orm.public.Voice.where({
            variant: "CUSTOM",
            orgId: ctx.orgId,
          }).where((v) => or(v.name.ilike(`%${q}%`), v.description.ilike(`%${q}%`)))
        : db.orm.public.Voice.where({
            variant: "CUSTOM",
            orgId: ctx.orgId,
          });

      const systemQuery = q
        ? db.orm.public.Voice.where({ variant: "SYSTEM" }).where((v) =>
            or(v.name.ilike(`%${q}%`), v.description.ilike(`%${q}%`)),
          )
        : db.orm.public.Voice.where({ variant: "SYSTEM" });

      const [custom, system] = await Promise.all([
        customQuery
          .select("id", "name", "description", "category", "language", "variant")
          .orderBy((v) => v.createdAt.desc())
          .all(),
        systemQuery
          .select("id", "name", "description", "category", "language", "variant")
          .orderBy((v) => v.name.asc())
          .all(),
      ]);

      return { custom, system };
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const voice = await db.orm.public.Voice.where({
        id: input.id,
        variant: "CUSTOM",
        orgId: ctx.orgId,
      })
        .select("id", "r2ObjectKey")
        .delete();

      if (!voice) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Voice not found",
        });
      }

      if (voice.r2ObjectKey) {
        // In production, consider background jobs, retries, cron jobs etc.
        await deleteAudio(voice.r2ObjectKey).catch(() => {});
      }

      return { success: true };
    }),
});
