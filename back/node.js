const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { del, put } = require('@vercel/blob');

// Safely load dotenv if available
try {
    require('dotenv').config();
} catch (e) {
    // Ignore if not present
}

const app = express();
const PORT = process.env.PORT || 3000;
const uploadDirectory = path.join(__dirname, 'uploads');
const sessionSecret = process.env.SESSION_SECRET || (process.env.VERCEL ? null : crypto.randomBytes(32).toString('hex'));
const sessionDurationSeconds = 7 * 24 * 60 * 60;

if (!process.env.VERCEL) fs.mkdirSync(uploadDirectory, { recursive: true });

// Middleware
app.use(express.json());
app.use(cors());
app.use('/uploads', express.static(uploadDirectory));
app.use(express.static(path.join(__dirname, '..', 'front')));

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    ssl: process.env.DB_SSL === 'true' ? {} : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Create connection pool connected directly to kisan_direct_db
const db = mysql.createPool({
    ...dbConfig,
    database: 'kisan_direct_db'
});

// Ensure users table exists on startup
async function createUsersTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            role ENUM('customer', 'farmer') NOT NULL,
            location VARCHAR(255) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    const [userColumns] = await db.query("SHOW COLUMNS FROM users LIKE 'location'");
    if (userColumns.length === 0) {
        await db.query('ALTER TABLE users ADD COLUMN location VARCHAR(255) NULL');
    }
    await db.query(`
        CREATE TABLE IF NOT EXISTS farmer_listings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            farmer_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            description VARCHAR(500) NOT NULL DEFAULT '',
            price DECIMAL(10, 2) NOT NULL,
            quantity DECIMAL(10, 2) NOT NULL,
            unit VARCHAR(20) NOT NULL,
            shelf_life_days INT NULL,
            image_path VARCHAR(255) NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);
    const [listingColumns] = await db.query("SHOW COLUMNS FROM farmer_listings LIKE 'shelf_life_days'");
    if (listingColumns.length === 0) {
        await db.query('ALTER TABLE farmer_listings ADD COLUMN shelf_life_days INT NULL');
    }
    await db.query(`
        CREATE TABLE IF NOT EXISTS purchase_orders (
            id INT AUTO_INCREMENT PRIMARY KEY,
            customer_id INT NOT NULL,
            total DECIMAL(12, 2) NOT NULL,
            delivery_location VARCHAR(255) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);
    const [orderColumns] = await db.query("SHOW COLUMNS FROM purchase_orders LIKE 'delivery_location'");
    if (orderColumns.length === 0) {
        await db.query('ALTER TABLE purchase_orders ADD COLUMN delivery_location VARCHAR(255) NULL');
    }
    await db.query(`
        CREATE TABLE IF NOT EXISTS purchase_items (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id INT NOT NULL,
            listing_id INT NULL,
            product_name VARCHAR(100) NOT NULL,
            farmer_name VARCHAR(100) NOT NULL,
            quantity DECIMAL(10, 2) NOT NULL,
            unit VARCHAR(20) NOT NULL,
            unit_price DECIMAL(10, 2) NOT NULL,
            discount_percent DECIMAL(5, 2) NOT NULL,
            line_total DECIMAL(12, 2) NOT NULL,
            FOREIGN KEY (order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
            FOREIGN KEY (listing_id) REFERENCES farmer_listings(id) ON DELETE SET NULL
        );
    `);
    console.log('Users table checked/created successfully.');
}

async function initializeDatabase() {
    if (process.env.VERCEL && (!sessionSecret || sessionSecret.length < 32)) {
        throw new Error('Set SESSION_SECRET to a random value of at least 32 characters.');
    }
    await createUsersTable();
}

let databaseInitialization;
if (process.env.VERCEL) {
    app.use((req, res, next) => {
        databaseInitialization ||= initializeDatabase();
        databaseInitialization.then(() => next()).catch(error => {
            databaseInitialization = null;
            console.error('Unable to initialize the application:', error);
            res.status(500).json({ success: false, message: 'The application is not configured correctly.' });
        });
    });
}

const imageExtensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
};

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, callback) => {
        if (!imageExtensions[file.mimetype]) {
            return callback(new Error('Please upload a JPG, PNG, or WebP image.'));
        }
        callback(null, true);
    }
});

function getSessionToken(req) {
    const cookie = (req.headers.cookie || '').split(';').map(part => part.trim())
        .find(part => part.startsWith('kd_session='));
    return cookie ? cookie.slice('kd_session='.length) : null;
}

function requireLogin(req, res, next) {
    const token = getSessionToken(req);
    const session = token && readSessionToken(token);
    if (!session) {
        return res.status(401).json({ success: false, message: 'Please log in to continue.' });
    }
    req.user = { id: session.id, role: session.role };
    next();
}

function createSessionToken(user) {
    if (!sessionSecret || sessionSecret.length < 32) {
        throw new Error('Set SESSION_SECRET to a random value of at least 32 characters.');
    }
    const payload = Buffer.from(JSON.stringify({
        id: Number(user.id),
        role: user.role,
        expiresAt: Math.floor(Date.now() / 1000) + sessionDurationSeconds
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('hex');
    return `${payload}.${signature}`;
}

function readSessionToken(token) {
    if (!sessionSecret) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;

    const expectedSignature = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
    const providedSignature = Buffer.from(signature, 'hex');
    if (providedSignature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(providedSignature, expectedSignature)) {
        return null;
    }

    try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!Number.isSafeInteger(session.id) ||
            !['customer', 'farmer'].includes(session.role) ||
            !Number.isSafeInteger(session.expiresAt) ||
            session.expiresAt <= Math.floor(Date.now() / 1000)) {
            return null;
        }
        return session;
    } catch {
        return null;
    }
}

function requireFarmer(req, res, next) {
    requireLogin(req, res, () => {
        if (req.user.role !== 'farmer') {
            return res.status(403).json({ success: false, message: 'Farmer access is required.' });
        }
        next();
    });
}

function requireCustomer(req, res, next) {
    requireLogin(req, res, () => {
        if (req.user.role !== 'customer') {
            return res.status(403).json({ success: false, message: 'Customer access is required.' });
        }
        next();
    });
}

function receiveListingImage(req, res, next) {
    upload.single('image')(req, res, error => {
        if (!error) return next();
        return res.status(400).json({
            success: false,
            message: error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
                ? 'Photo must be 4 MB or smaller.'
                : error.message
        });
    });
}

async function saveListingImage(file) {
    const filename = `${crypto.randomUUID()}${imageExtensions[file.mimetype]}`;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
        const blob = await put(`listings/${filename}`, file.buffer, {
            access: 'public',
            addRandomSuffix: false,
            contentType: file.mimetype
        });
        return blob.url;
    }
    if (process.env.VERCEL) {
        throw new Error('Configure BLOB_READ_WRITE_TOKEN in Vercel before uploading product photos.');
    }
    await fs.promises.writeFile(path.join(uploadDirectory, filename), file.buffer, { flag: 'wx' });
    return `/uploads/${filename}`;
}

async function removeListingImage(imagePath) {
    if (imagePath.startsWith('https://')) {
        await del(imagePath);
        return;
    }
    const filename = path.basename(imagePath);
    await fs.promises.unlink(path.join(uploadDirectory, filename));
}

async function hasValidImageSignature(file) {
    const header = file.buffer.subarray(0, 12);
    if (file.mimetype === 'image/jpeg') {
        return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    }
    if (file.mimetype === 'image/png') {
        return header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    return file.mimetype === 'image/webp' &&
        header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' &&
        header.toString('ascii', 8, 12) === 'WEBP';
}

// --- API ROUTES ---

// 1. REGISTER ROUTE
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        if (!name || !email || !password || !['customer', 'farmer'].includes(role)) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        // Check if user already exists
        const [existingUsers] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ success: false, message: 'Email is already registered.' });
        }

        // Hash the password securely
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Insert new user into database
        await db.query(
            'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            [name, email, hashedPassword, role]
        );

        res.status(201).json({ success: true, message: 'Registration successful! You can now log in.' });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
});

// 2. LOGIN ROUTE
app.post('/api/login', async (req, res) => {
    try {
        const { email, password, role } = req.body;

        if (!email || !password || !role) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        // Find user by email and role
        const [users] = await db.query('SELECT * FROM users WHERE email = ? AND role = ?', [email, role]);
        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid email, password, or role.' });
        }

        const user = users[0];

        // Compare submitted password with stored hashed password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid email, password, or role.' });
        }

        const token = createSessionToken(user);
        const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `kd_session=${token}; Max-Age=${sessionDurationSeconds}; Path=/; HttpOnly; SameSite=Lax${secureCookie}`);
        res.status(200).json({
            success: true,
            message: `Welcome back, ${user.name}!`,
            user: { id: user.id, name: user.name, email: user.email, role: user.role, location: user.location }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

app.get('/api/me', requireLogin, async (req, res) => {
    try {
        const [users] = await db.query('SELECT id, name, email, role, location FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0) {
            return res.status(401).json({ success: false, message: 'Account no longer exists.' });
        }
        res.json({ success: true, user: users[0] });
    } catch (error) {
        console.error('Session lookup error:', error);
        res.status(500).json({ success: false, message: 'Unable to load your account.' });
    }
});

app.put('/api/location', requireLogin, async (req, res) => {
    try {
        const { location } = req.body;
        if (typeof location !== 'string' || location.trim().length > 255) {
            return res.status(400).json({ success: false, message: 'Enter a location up to 255 characters.' });
        }
        const savedLocation = location.trim() || null;
        await db.query('UPDATE users SET location = ? WHERE id = ?', [savedLocation, req.user.id]);
        res.json({ success: true, location: savedLocation, message: 'Location saved.' });
    } catch (error) {
        console.error('Save location error:', error);
        res.status(500).json({ success: false, message: 'Unable to save your location.' });
    }
});

app.post('/api/logout', (req, res) => {
    const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `kd_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secureCookie}`);
    res.json({ success: true });
});

app.get('/api/customer/listings', requireCustomer, async (req, res) => {
    try {
        const [listings] = await db.query(
            `SELECT l.id, l.name, l.description, l.price, l.quantity, l.unit,
                    l.shelf_life_days AS shelfLifeDays,
                    l.image_path AS imagePath, l.created_at AS createdAt,
                    u.name AS farmerName, u.location AS farmerLocation
             FROM farmer_listings l
             JOIN users u ON u.id = l.farmer_id
             WHERE l.is_active = TRUE AND l.quantity > 0
             ORDER BY l.created_at DESC`
        );
        res.json({ success: true, listings });
    } catch (error) {
        console.error('Customer listings error:', error);
        res.status(500).json({ success: false, message: 'Unable to load available products.' });
    }
});

app.get('/api/customer/orders', requireCustomer, async (req, res) => {
    try {
        const [orders] = await db.query(
            `SELECT o.id, o.total, o.delivery_location AS deliveryLocation,
                    o.created_at AS createdAt,
                    i.product_name AS productName, i.farmer_name AS farmerName,
                    i.quantity, i.unit, i.unit_price AS unitPrice,
                    i.discount_percent AS discountPercent, i.line_total AS lineTotal
             FROM purchase_orders o
             JOIN purchase_items i ON i.order_id = o.id
             WHERE o.customer_id = ?
             ORDER BY o.created_at DESC, i.id`,
            [req.user.id]
        );
        res.json({ success: true, orders });
    } catch (error) {
        console.error('Customer orders error:', error);
        res.status(500).json({ success: false, message: 'Unable to load your purchase history.' });
    }
});

app.post('/api/customer/purchases', requireCustomer, async (req, res) => {
    const listingId = Number(req.body.listingId);
    const quantity = Number(req.body.quantity);
    if (!Number.isSafeInteger(listingId) || listingId <= 0 ||
        !Number.isFinite(quantity) || quantity <= 0 ||
        Math.abs(quantity * 100 - Math.round(quantity * 100)) > 1e-8) {
        return res.status(400).json({ success: false, message: 'Choose a product and enter a valid quantity.' });
    }

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();
        const [customers] = await connection.query(
            'SELECT location FROM users WHERE id = ? FOR UPDATE',
            [req.user.id]
        );
        const deliveryLocation = customers[0] && customers[0].location;
        if (!deliveryLocation) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'Save your delivery location before placing an order.'
            });
        }
        const [listings] = await connection.query(
            `SELECT l.id, l.name, l.price, l.quantity, l.unit, l.is_active,
                    l.farmer_id, u.name AS farmerName
             FROM farmer_listings l
             JOIN users u ON u.id = l.farmer_id
             WHERE l.id = ?
             FOR UPDATE`,
            [listingId]
        );
        const listing = listings[0];
        if (!listing || !listing.is_active) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'This product is no longer available.' });
        }
        if (quantity > Number(listing.quantity)) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: `Only ${Number(listing.quantity)} ${listing.unit} currently available.`
            });
        }

        const discountPercent = quantity >= 25 ? 10 : quantity >= 10 ? 5 : 0;
        const subtotal = Number(listing.price) * quantity;
        const total = Math.round(subtotal * (1 - discountPercent / 100) * 100) / 100;
        const [orderResult] = await connection.query(
            'INSERT INTO purchase_orders (customer_id, total, delivery_location) VALUES (?, ?, ?)',
            [req.user.id, total.toFixed(2), deliveryLocation]
        );
        await connection.query(
            `INSERT INTO purchase_items
                (order_id, listing_id, product_name, farmer_name, quantity, unit,
                 unit_price, discount_percent, line_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orderResult.insertId, listing.id, listing.name, listing.farmerName,
                quantity, listing.unit, listing.price, discountPercent, total.toFixed(2)
            ]
        );
        await connection.query(
            'UPDATE farmer_listings SET quantity = quantity - ? WHERE id = ?',
            [quantity, listing.id]
        );
        await connection.commit();
        res.status(201).json({
            success: true,
            message: 'Purchase placed successfully.',
            order: {
                id: orderResult.insertId, productName: listing.name, quantity, unit: listing.unit,
                discountPercent, total
            }
        });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Customer purchase error:', error);
        res.status(500).json({ success: false, message: 'Unable to complete this purchase.' });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/api/farmer/listings', requireFarmer, async (req, res) => {
    try {
        const [listings] = await db.query(
            `SELECT id, name, description, price, quantity, unit,
                    shelf_life_days AS shelfLifeDays, image_path AS imagePath,
                    (SELECT location FROM users WHERE id = farmer_id) AS farmerLocation,
                    is_active AS isActive, created_at AS createdAt
             FROM farmer_listings WHERE farmer_id = ? ORDER BY is_active DESC, created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, listings });
    } catch (error) {
        console.error('Farmer listings error:', error);
        res.status(500).json({ success: false, message: 'Unable to load your listings.' });
    }
});

app.post('/api/farmer/listings', requireFarmer, receiveListingImage, async (req, res) => {
    let imagePath;
    try {
        const { name, description = '', price, quantity, unit, shelfLifeDays } = req.body;
        const parsedPrice = Number(price);
        const parsedQuantity = Number(quantity);
        const parsedShelfLifeDays = Number(shelfLifeDays);
        const validUnits = ['kg', 'g', 'bunch', 'box', 'piece'];

        if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 ||
            typeof description !== 'string' || description.length > 500 ||
            !Number.isFinite(parsedPrice) || parsedPrice <= 0 ||
            !Number.isFinite(parsedQuantity) || parsedQuantity <= 0 ||
            !Number.isInteger(parsedShelfLifeDays) || parsedShelfLifeDays < 1 || parsedShelfLifeDays > 365 ||
            !validUnits.includes(unit) || !req.file) {
            return res.status(400).json({
                success: false,
                message: 'Provide a name, positive price and quantity, shelf life from 1 to 365 days, valid unit, and product photo up to 4 MB.'
            });
        }
        if (!await hasValidImageSignature(req.file)) {
            return res.status(400).json({ success: false, message: 'The uploaded file is not a valid image.' });
        }

        imagePath = await saveListingImage(req.file);
        const [result] = await db.query(
            `INSERT INTO farmer_listings
                (farmer_id, name, description, price, quantity, unit, shelf_life_days, image_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, name.trim(), description.trim(), parsedPrice, parsedQuantity, unit, parsedShelfLifeDays, imagePath]
        );
        res.status(201).json({
            success: true,
            listing: {
                id: result.insertId, name: name.trim(), description: description.trim(),
                price: parsedPrice, quantity: parsedQuantity, unit,
                shelfLifeDays: parsedShelfLifeDays, imagePath, isActive: 1
            }
        });
    } catch (error) {
        if (imagePath) {
            try {
                await removeListingImage(imagePath);
            } catch (cleanupError) {
                console.error('Unable to remove uploaded listing image:', cleanupError);
            }
        }
        console.error('Create listing error:', error);
        res.status(500).json({ success: false, message: 'Unable to save this listing.' });
    }
});

app.post('/api/farmer/listings/:id/archive', requireFarmer, async (req, res) => {
    try {
        const [result] = await db.query(
            'UPDATE farmer_listings SET is_active = FALSE WHERE id = ? AND farmer_id = ? AND is_active = TRUE',
            [req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Active listing not found.' });
        }
        res.json({ success: true, message: 'Listing moved to previous items.' });
    } catch (error) {
        console.error('Archive listing error:', error);
        res.status(500).json({ success: false, message: 'Unable to update this listing.' });
    }
});

async function startServer() {
    try {
        await initializeDatabase();
        app.listen(PORT, () => {
            console.log(`Kisan Direct server running at http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Unable to start Kisan Direct server:', error);
        process.exitCode = 1;
    }
}

if (require.main === module) startServer();

module.exports = app;