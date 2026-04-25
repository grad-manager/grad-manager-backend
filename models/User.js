import mongoose from 'mongoose';

const Schema = mongoose.Schema;

const UserSchema = new Schema({
    firebaseUid: {
        type: String,
        required: true,
        unique: true
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String
    },
    // 🚨 NEW FIELDS ADDED 🚨
    firstName: {
        type: String 
    },
    lastName: {
        type: String 
    },
    photoURL: {
        type: String,
        default: null
    },
    gender: {
        type: String,
        enum: ['Male', 'Female', 'Non-binary', 'Prefer not to say', null], 
        default: null
    },
    bio: {
        type: String,
        default: null,
        maxlength: 500
    },
    // 🚨 NEW FIELD FOR TARGET COUNTRY 🚨
    targetCountry: { 
        type: String, 
        default: null,
        trim: true
    },
    // ----------------------
    mentorId: {
        type: Schema.Types.ObjectId,
        ref: 'Mentor', 
        default: null,
    },
    isConnectedToMentor: {
        type: Boolean,
        default: false,
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export default mongoose.model('User', UserSchema);