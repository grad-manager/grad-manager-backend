import mongoose from 'mongoose';

const Schema = mongoose.Schema;

const ProgramSchema = new Schema({
    university: {
        type: String,
        required: true,
    },
    department: {
        type: String,
        required: true,
    },
    funding: String,
    fundingAmount: String, // <-- New field for funding amount
    deadline: String, // <-- New field for application deadline
    greWaiver: String,
    ieltsWaiver: String,
    appFeeWaiver: String,
    requiredDocs: {
  type: [String],
  default: [],
},
    appLink: String,
});

export default mongoose.model('Program', ProgramSchema);