import mongoose from 'mongoose';

const Schema = mongoose.Schema;

const FeedbackSchema = new Schema({
  userId: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model('Feedback', FeedbackSchema);