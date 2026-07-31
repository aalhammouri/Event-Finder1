import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const urlListsTable = pgTable("url_lists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const urlListItemsTable = pgTable("url_list_items", {
  id: serial("id").primaryKey(),
  urlListId: serial("url_list_id").notNull().references(() => urlListsTable.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUrlListSchema = createInsertSchema(urlListsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUrlList = z.infer<typeof insertUrlListSchema>;
export type UrlList = typeof urlListsTable.$inferSelect;
export type UrlListItem = typeof urlListItemsTable.$inferSelect;
