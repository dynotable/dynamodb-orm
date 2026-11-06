import dynamoose from '@acme/dynamoose';

// TODO(dynotable-orm-codemod): new Schema(): 'email' has a set modifier, which has no dynotable-orm equivalent
export const userSchema = new dynamoose.Schema({
  id: String,
  email: {type: String, set: (email) => String(email).toLowerCase()}
});
// TODO(dynotable-orm-codemod): model(): its schema does not convert
export const User = dynamoose.model('User', userSchema);

// TODO(dynotable-orm-codemod): model(): 'parent': dynamoose.type.THIS has no dynotable-orm equivalent
export const Tree = dynamoose.model('Tree', new dynamoose.Schema({id: String, parent: dynamoose.type.THIS}));
// TODO(dynotable-orm-codemod): model(): the model setting expires has no dynotable-orm equivalent
export const Session = dynamoose.model('Session', {id: String}, {expires: 1000});

// TODO(dynotable-orm-codemod): new Schema(): saveUnknown '*': only '**' and '<Object attribute>.**' convert; 'lines': an Array converts only with a schema of one element type; logSchema is used other than as model()'s schema: logSchema.getHashKey
const logSchema = new dynamoose.Schema({id: String, lines: Array}, {saveUnknown: ['*']});
export const logKey = () => logSchema.getHashKey();
// TODO(dynotable-orm-codemod): model(): its schema does not convert
export const Log = dynamoose.model('Log', logSchema);

// dynamoose awaits an async set hook.
// TODO(dynotable-orm-codemod): model(): the schema setting set returns a Promise: the dynotable-orm set hook is synchronous
export const Hooked = dynamoose.model('Hooked', new dynamoose.Schema({id: String}, {set: async (item) => item}));

// A parameter of the function around model() has the name the generated options would take.
// TODO(dynotable-orm-codemod): new Schema(): a model() of this schema does not convert
const shadowSchema = new dynamoose.Schema({id: String});
// TODO(dynotable-orm-codemod): model(): shadowOptions is bound to something else here: rename that binding, then run again
export const makeShadow = (shadowOptions: object) => [dynamoose.model('Shadow', shadowSchema), shadowOptions];

// dynamoose awaits an async default, and validates a Date in its stored form.
// TODO(dynotable-orm-codemod): model(): 'token': the default returns a Promise, which dynamoose awaits: a Zod default is synchronous
export const Later = dynamoose.model('Later', new dynamoose.Schema({id: String, token: {type: String, default: async () => 'later'}}));
// TODO(dynotable-orm-codemod): model(): 'at': validate on a Date gets the stored number or string in dynamoose, and a Date in a refinement: convert it by hand
export const Dated = dynamoose.model('Dated', new dynamoose.Schema({id: String, at: {type: Date, validate: (v: unknown) => typeof v === 'number'}}));
// dynamoose's required check refuses a $SET to undefined, and a $REMOVE when the default is falsy; a Zod default allows both.
// TODO(dynotable-orm-codemod): model(): 'n': required with a default: dynamoose refuses an update that sets it to undefined, or that removes it when the default is falsy (it writes a truthy default), and a Zod default allows both: convert it by hand
export const Counted = dynamoose.model('Counted', new dynamoose.Schema({id: String, n: {type: Number, required: true, default: 0}}));
// dynamoose stores a Date attribute's default as it is: Date.now gives a number.
// TODO(dynotable-orm-codemod): model(): 'at': the default of a Date gives no Date, and dynamoose stores what it gives: convert it by hand
export const Stamped = dynamoose.model('Stamped', new dynamoose.Schema({id: String, at: {type: Date, default: Date.now}}));
// dynamoose reads any truthy required as required.
const MUST = true;
// TODO(dynotable-orm-codemod): model(): 's': required is not a literal
export const Must = dynamoose.model('Must', new dynamoose.Schema({id: String, s: {type: String, required: MUST, default: ''}}));
// Object.values() of an enum with a numeric member also holds that member's name: only a string enum converts.
enum Grade {
  Pass = 'pass',
  Retry = 1
}
// TODO(dynotable-orm-codemod): model(): 'grade': only an enum of string or number literals, or Object.values() of a string enum, converts
export const Graded = dynamoose.model('Graded', new dynamoose.Schema({id: String, grade: {type: String, enum: Object.values(Grade)}}));
