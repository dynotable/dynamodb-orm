import dynamoose from '@acme/dynamoose';

export const userSchema = new dynamoose.Schema({
  id: String,
  email: {type: String, set: (email) => String(email).toLowerCase()}
});
export const User = dynamoose.model('User', userSchema);

export const Tree = dynamoose.model('Tree', new dynamoose.Schema({id: String, parent: dynamoose.type.THIS}));
export const Session = dynamoose.model('Session', {id: String}, {expires: 1000});

const logSchema = new dynamoose.Schema({id: String, lines: Array}, {saveUnknown: ['*']});
export const logKey = () => logSchema.getHashKey();
export const Log = dynamoose.model('Log', logSchema);

// dynamoose awaits an async set hook.
export const Hooked = dynamoose.model('Hooked', new dynamoose.Schema({id: String}, {set: async (item) => item}));

// A parameter of the function around model() has the name the generated options would take.
const shadowSchema = new dynamoose.Schema({id: String});
export const makeShadow = (shadowOptions: object) => [dynamoose.model('Shadow', shadowSchema), shadowOptions];

// dynamoose awaits an async default, and validates a Date in its stored form.
export const Later = dynamoose.model('Later', new dynamoose.Schema({id: String, token: {type: String, default: async () => 'later'}}));
export const Dated = dynamoose.model('Dated', new dynamoose.Schema({id: String, at: {type: Date, validate: (v: unknown) => typeof v === 'number'}}));
// dynamoose's required check refuses a $SET to undefined, and a $REMOVE when the default is falsy; a Zod default allows both.
export const Counted = dynamoose.model('Counted', new dynamoose.Schema({id: String, n: {type: Number, required: true, default: 0}}));
// dynamoose stores a Date attribute's default as it is: Date.now gives a number.
export const Stamped = dynamoose.model('Stamped', new dynamoose.Schema({id: String, at: {type: Date, default: Date.now}}));
// dynamoose reads any truthy required as required.
const MUST = true;
export const Must = dynamoose.model('Must', new dynamoose.Schema({id: String, s: {type: String, required: MUST, default: ''}}));
// Object.values() of an enum with a numeric member also holds that member's name: only a string enum converts.
enum Grade {
  Pass = 'pass',
  Retry = 1
}
export const Graded = dynamoose.model('Graded', new dynamoose.Schema({id: String, grade: {type: String, enum: Object.values(Grade)}}));
