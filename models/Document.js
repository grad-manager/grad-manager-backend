import mongoose from 'mongoose';

const documentSchema = new mongoose.Schema({
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', required: true },
    userId: { type: String, required: true },
    fileName: { type: String, required: true },
    fileUrl: { type: String, required: true },
    fileType: { type: String, required: true }, // e.g., 'Statement of Purpose', 'CV'
    
    // NEW: Fields for document review workflow
    status: {
        type: String,
        enum: ['uploaded', 'pending_review', 'review_complete'],
        default: 'uploaded',
    },
    correctedFileUrl: {
        type: String,
        required: false,
    },
    filePublicId: { type: String, 
        required: true 
    },
    
    uploadedAt: { type: Date, default: Date.now }
});

const Document = mongoose.model('Document', documentSchema);

export default Document;