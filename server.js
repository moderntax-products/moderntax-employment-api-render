// server.js - ModernTax Backend with Employer.com Format
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Supabase setup
const supabaseUrl = 'https://nixzwnfjglojemozlvmf.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5peHp3bmZqZ2xvamVtb3psdm1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc5NjMzMzMsImV4cCI6MjA3MzUzOTMzM30.qx8VUmL9EDlxtCNj4CF04Ld9xCFWDugNHhAmV0ixfuQ';
const supabase = createClient(supabaseUrl, supabaseKey);

// File upload setup
const upload = multer({ 
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype === 'application/json') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and JSON files allowed'));
    }
  }
});

// STEP 1: 8821 FORM INTAKE
app.post('/api/v1/transcript-requests/create', async (req, res) => {
  try {
    const { ssn, first_name, last_name, email, employer_name, webhook_url } = req.body;

    if (!ssn || !first_name || !last_name || !email) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['ssn', 'first_name', 'last_name', 'email'],
      });
    }

    const requestId = `TR_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const { data, error } = await supabase.from('transcript_requests').insert({
      request_id: requestId,
      ssn,
      first_name,
      last_name,
      email,
      employer_name: employer_name || 'Not specified',
      webhook_url: webhook_url || null,
      status: 'pending_8821_submission',
      created_at: new Date().toISOString(),
      client: 'employer_com',
      cost: 59.98,
    });

    if (error) throw error;

    return res.status(201).json({
      request_id: requestId,
      status: 'pending_8821_submission',
      message: '8821 form submitted. Our team will request IRS transcripts within 24 hours.',
      taxpayer: {
        name: `${first_name} ${last_name}`,
        ssn_last_four: ssn.slice(-4),
      },
      estimated_completion: '1-2 business days',
      cost: '$59.98',
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// STEP 2: CHECK REQUEST STATUS
app.get('/api/v1/transcript-requests/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;

    const { data, error } = await supabase
      .from('transcript_requests')
      .select('*')
      .eq('request_id', requestId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Request not found' });
    }

    return res.status(200).json({
      request_id: data.request_id,
      status: data.status,
      taxpayer: {
        name: `${data.first_name} ${data.last_name}`,
        ssn_last_four: data.ssn.slice(-4),
      },
      created_at: data.created_at,
      completed_at: data.completed_at || null,
      income_data: data.income_data || null,
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// STEP 3: EXPERT UPLOAD TRANSCRIPT
app.post('/api/v1/transcripts/upload', upload.single('file'), async (req, res) => {
  try {
    const { requestId, year } = req.body;

    if (!requestId || !year || !req.file) {
      return res.status(400).json({
        error: 'Missing required fields: requestId, year, file',
      });
    }

    const { data: request, error: fetchError } = await supabase
      .from('transcript_requests')
      .select('*')
      .eq('request_id', requestId)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    let parsedData;
    if (req.file.mimetype === 'application/json') {
      parsedData = JSON.parse(req.file.buffer.toString());
    } else {
      return res.status(400).json({ error: 'PDF parsing requires manual conversion to JSON first' });
    }

    if (!parsedData.metadata || !parsedData.income_by_year) {
      return res.status(400).json({ error: 'Invalid transcript format' });
    }

    await supabase.from('parsed_transcripts').insert({
      request_id: requestId,
      year,
      raw_data: parsedData,
      parsed_at: new Date().toISOString(),
      status: 'parsed',
    });

    await supabase
      .from('transcript_requests')
      .update({
        status: 'transcript_received',
        income_data: parsedData,
        completed_at: new Date().toISOString(),
      })
      .eq('request_id', requestId);

    await supabase
      .from('transactions')
      .insert({
        request_id: requestId,
        amount: 59.98,
        status: 'billed',
        client: 'employer_com',
      });

    if (request.webhook_url) {
      sendWebhook(request.webhook_url, formatWebhookResponse(parsedData, request));
    }

    return res.status(200).json({
      message: 'Transcript uploaded successfully',
      request_id: requestId,
      webhook_sent: !!request.webhook_url,
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function formatWebhookResponse(transcriptData, request) {
  return {
    request_id: request.request_id,
    status: 'completed',
    timestamp: new Date().toISOString(),
    taxpayer: {
      name: `${request.first_name} ${request.last_name}`,
      ssn_last_four: request.ssn.slice(-4),
    },
    income_verification: {
      years_processed: Object.keys(transcriptData.income_by_year || {}),
      income_by_year: transcriptData.income_by_year || {},
      employers: transcriptData.employers || [],
      forms_found: transcriptData.forms_found || [],
      multi_employer_detected: transcriptData.metadata?.multi_employer_detected || false,
    },
    billing: {
      amount: 59.98,
      status: 'billed',
    },
  };
}

async function sendWebhook(webhookUrl, payload) {
  try {
    await axios.post(webhookUrl, payload, { timeout: 10000 });
  } catch (error) {
    console.error('Webhook failed:', error.message);
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ModernTax Employment Verification Backend',
    endpoints: {
      'POST /api/v1/transcript-requests/create': '8821 intake',
      'GET /api/v1/transcript-requests/:id': 'Check status',
      'POST /api/v1/transcripts/upload': 'Upload transcript',
    },
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
