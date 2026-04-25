import mongoose from 'mongoose';

const Schema = mongoose.Schema;

const MentorSchema = new Schema({
    name: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
    },
    expertise: {
        type: [String], // An array of strings for their areas of expertise
        required: true,
    },
    isAvailable: {
        type: Boolean,
        default: true, // A flag to easily find an available mentor
    },
    connectedUsers: [{
        type: Schema.Types.ObjectId,
        ref: 'User', // An array of users they are mentoring
    }],
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

export default mongoose.model('Mentor', MentorSchema);