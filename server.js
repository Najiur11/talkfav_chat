const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database Connection
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err);
    } else {
        console.log(`Connected to MySQL Database: ${process.env.DB_NAME}`);
    }
});

// Root Route Test
app.get('/', (req, res) => {
    res.send('Talkfav Backend Server is running successfully!');
});

// ==========================================
// 1. User Registration Route
// ==========================================
app.post('/api/register', async (req, res) => {
    const { name, email, country, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
        return res.status(400).json({ message: 'Please fill in all required fields.' });
    }

    try {
        const checkUserSql = 'SELECT * FROM users WHERE email = ?';
        db.query(checkUserSql, [email], async (err, results) => {
            if (err) {
                return res.status(500).json({ message: 'Database query error', error: err });
            }

            if (results.length > 0) {
                return res.status(400).json({ message: 'Email is already registered!' });
            }

            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);

            const insertSql = 'INSERT INTO users (name, email, country, phone, password) VALUES (?, ?, ?, ?, ?)';
            db.query(insertSql, [name, email, country, phone, hashedPassword], (err, result) => {
                if (err) {
                    return res.status(500).json({ message: 'Failed to register user', error: err });
                }
                res.status(201).json({ message: 'User registered successfully!' });
            });
        });

    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// ==========================================
// 2. User Login Route
// ==========================================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required!' });
    }

    try {
        const sql = 'SELECT * FROM users WHERE email = ?';
        db.query(sql, [email], async (err, results) => {
            if (err) {
                return res.status(500).json({ message: 'Database error', error: err });
            }

            if (results.length === 0) {
                return res.status(400).json({ message: 'User not found! Please register first.' });
            }

            const user = results[0];

            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                return res.status(400).json({ message: 'Invalid password!' });
            }

            res.status(200).json({
                message: 'Login successful!',
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    country: user.country,
                    phone: user.phone
                }
            });
        });

    } catch (error) {
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// ==========================================
// 3. SEARCH USERS ROUTE
// ==========================================
app.get('/api/users/search', (req, res) => {
    const { query, currentUserId } = req.query;
    const searchTerm = `%${query}%`;
    const sql = `SELECT id, name, email, country, phone FROM users WHERE (name LIKE ? OR email LIKE ?) AND id != ?`;
    
    db.query(sql, [searchTerm, searchTerm, currentUserId], (err, results) => {
        if (err) return res.status(500).json({ message: 'Search failed', error: err });
        res.status(200).json({ users: results });
    });
});

// ==========================================
// 4. FRIEND REQUEST ROUTES
// ==========================================
app.post('/api/friend-request/send', (req, res) => {
    const { sender_id, receiver_id } = req.body;
    const sql = 'INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES (?, ?, "pending")';
    
    db.query(sql, [sender_id, receiver_id], (err, result) => {
        if (err) return res.status(500).json({ message: 'Failed to send request', error: err });
        res.status(200).json({ message: 'Friend request sent successfully!' });
    });
});

app.get('/api/friend-request/pending/:userId', (req, res) => {
    const userId = req.params.userId;
    const sql = `
        SELECT fr.id as request_id, u.id as sender_id, u.name, u.email 
        FROM friend_requests fr 
        JOIN users u ON fr.sender_id = u.id 
        WHERE fr.receiver_id = ? AND fr.status = 'pending'
    `;
    
    db.query(sql, [userId], (err, results) => {
        if (err) return res.status(500).json({ message: 'Error fetching requests', error: err });
        res.status(200).json({ requests: results });
    });
});

app.post('/api/friend-request/accept', (req, res) => {
    const { request_id } = req.body;
    const sql = 'UPDATE friend_requests SET status = "accepted" WHERE id = ?';
    
    db.query(sql, [request_id], (err, result) => {
        if (err) return res.status(500).json({ message: 'Failed to accept request', error: err });
        res.status(200).json({ message: 'Friend request accepted!' });
    });
});

app.get('/api/friends/:userId', (req, res) => {
    const userId = req.params.userId;
    const sql = `
        SELECT u.id, u.name, u.email, u.country, u.phone 
        FROM users u 
        JOIN friend_requests fr ON (u.id = fr.sender_id OR u.id = fr.receiver_id)
        WHERE (fr.sender_id = ? OR fr.receiver_id = ?) 
        AND fr.status = 'accepted' 
        AND u.id != ?
    `;
    
    db.query(sql, [userId, userId, userId], (err, results) => {
        if (err) return res.status(500).json({ message: 'Error fetching friends', error: err });
        res.status(200).json({ friends: results });
    });
});

// ==========================================
// 5. MESSAGING ROUTES
// ==========================================
app.post('/api/messages/send', (req, res) => {
    const { sender_id, receiver_id, message } = req.body;
    const sql = 'INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)';
    
    db.query(sql, [sender_id, receiver_id, message], (err, result) => {
        if (err) return res.status(500).json({ message: 'Failed to send message', error: err });
        res.status(200).json({ message: 'Message sent!' });
    });
});

app.get('/api/messages/:user1/:user2', (req, res) => {
    const { user1, user2 } = req.params;
    const sql = `
        SELECT * FROM messages 
        WHERE (sender_id = ? AND receiver_id = ?) 
           OR (sender_id = ? AND receiver_id = ?) 
        ORDER BY created_at ASC
    `;
    
    db.query(sql, [user1, user2, user2, user1], (err, results) => {
        if (err) return res.status(500).json({ message: 'Failed to fetch messages', error: err });
        res.status(200).json({ messages: results });
    });
});

// ==========================================
// 6. Server Listen (ALWAYS AT THE VERY BOTTOM)
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});