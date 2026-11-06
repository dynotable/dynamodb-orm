import dynamoose from '@acme/dynamoose';

export enum Mood {
  Calm = 'calm',
  Wild = 'wild'
}

export const catSchema = new dynamoose.Schema(
  {
    id: {type: String, hashKey: true},
    born: {type: Number, rangeKey: true},
    name: {type: String, required: true, index: {name: 'name-index', project: ['id'], throughput: 5}},
    breed: {type: String, enum: ['siamese', 'persian'], default: 'siamese'},
    lives: {type: Number, default: () => 9, validate: (lives) => lives > 0},
    tag: {type: String, validate: /^[a-z]+$/, index: true},
    toys: {type: Set, schema: [String]},
    weights: {type: Set, schema: [Number]},
    chip: Buffer,
    adopted: Date,
    vetVisit: {type: {value: Date, settings: {storage: 'seconds'}}},
    owner: {
      type: Object,
      schema: {
        name: {type: String, required: true},
        since: {type: {value: Date, settings: {storage: 'iso'}}}
      }
    },
    meals: {type: Array, schema: [{type: Object, schema: {food: {type: String, required: true}, grams: Number}}]},
    nickname: [String, dynamoose.type.NULL],
    room: {type: String, index: [{name: 'room-index'}, {name: 'room-born', rangeKey: 'born', project: false}]},
    size: {type: Number, enum: [1, 2, 3]},
    mood: {type: String, enum: Object.values(Mood)},
    lookup: {type: dynamoose.type.COMBINE(['name', 'breed'], '#')},
    indoor: Boolean
  },
  {timestamps: true}
);

export const Cat = dynamoose.model('Cat', catSchema, {create: false, waitForActive: false});
