import {model} from 'dynotable-orm';
import {z} from 'zod';

export enum Mood {
  Calm = 'calm',
  Wild = 'wild'
}

export const catSchema = z.object({
  id: z.string(),
  born: z.number(),
  name: z.string(),
  breed: z.enum(['siamese', 'persian']).default('siamese'),
  lives: z.number().refine((lives) => lives > 0).default(() => 9),
  tag: z.string().regex(/^[a-z]+$/).optional(),
  toys: z.set(z.string()).optional(),
  weights: z.set(z.number()).optional(),
  chip: z.instanceof(Buffer).optional(),
  adopted: z.date().optional(),
  vetVisit: z.date().optional(),
  owner: z.object({
    name: z.string(),
    since: z.date().optional()
  }).optional(),
  meals: z.array(z.object({
    food: z.string(),
    grams: z.number().optional()
  })).optional(),
  nickname: z.union([z.string(), z.null()]).optional(),
  room: z.string().optional(),
  size: z.literal([1, 2, 3]).optional(),
  mood: z.enum(Mood).optional(),
  lookup: z.string().optional(),
  indoor: z.boolean().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional()
});
export const catOptions = {hashKey: 'id', rangeKey: 'born', indexes: {name: {name: 'name-index', project: ['id']}, tag: {}, room: [{name: 'room-index'}, {name: 'room-born', rangeKey: 'born', project: false}]}, combine: {lookup: {sources: ['name', 'breed'], separator: '#'}}, dates: {vetVisit: 'seconds', 'owner.since': 'iso'}, timestamps: true} as const;

export const Cat = model('Cat', catSchema, catOptions);
