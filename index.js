require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const admin = require('firebase-admin')

const port = process.env.PORT || 5000
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()
// middleware
app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        'https://club-management-o1cz.vercel.app',
        'http://localhost:5173',
      ]
      // Vercel preview deployments allow করুন
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
        callback(null, true)
      } else {
        callback(new Error('CORS not allowed'))
      }
    },
    credentials: true,
    optionSuccessStatus: 200,
  })
)




app.use(express.json())

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    req.user = decoded
    next()
  } catch (err) {
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})


async function run() {
  try {


    const db = client.db('ClubManageDB')
    const usersCollection = db.collection('users')
    const clubsCollection = db.collection('clubs')
    const eventsCollection = db.collection('events')
    const membersCollection = db.collection('members')
    const paymentsCollection = db.collection('payments')
    const managersCollection = db.collection('managers')
    const adminsCollection = db.collection('admins')

    const verifyADMIN = async (req, res, next) => {
      const email = req.tokenEmail
      const user = await usersCollection.findOne({ email })
      if (user?.role !== 'admin') {
        return res
          .status(403)
          .send({ message: 'Admin only Actions!', role: user?.role })
      }
      next()
    }

    // verify Manager 
    const verifyManager = async (req, res, next) => {
      const email = req.tokenEmail
      const user = await usersCollection.findOne({ email })
      if (user?.role !== 'manager') {
        return res
          .status(403)
          .send({ message: 'manager only Actions!', role: user?.role })
      }
      next()
    }


    // Create Club Payment Session
    app.post('/api/create-club-checkout-session', async (req, res) => {
      try {
        const paymentInfo = req.body
        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: paymentInfo.name,
                  description: paymentInfo.description,
                  images: [paymentInfo.image],
                },
                unit_amount: paymentInfo.price * 100
              },
              quantity: 1,
            },
          ],
          customer_email: paymentInfo.member.email,
          mode: 'payment',
          metadata: {
            clubId: paymentInfo.clubId,
            memberEmail: paymentInfo.member.email,
            memberName: paymentInfo.member.name,
            memberImage: paymentInfo.member.image
          },
          success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_DOMAIN}/club/${paymentInfo.clubId}`
        })

        res.send({ url: session.url })
      } catch (err) {
        console.error('Stripe session error:', err)
        res.status(500).send({ error: err.message })
      }
    })

    // event registration payment 
    app.post('/api/create-event-checkout-session', async (req, res) => {
      const paymentInfo = req.body
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: paymentInfo.name,
                description: paymentInfo.description,
                images: [paymentInfo.image]
              },
              unit_amount: paymentInfo.price * 100
            },
            quantity: 1
          }
        ],
        customer_email: paymentInfo.member.email,
        mode: 'payment',

        metadata: {
          eventId: paymentInfo.eventId,
          eventTitle: paymentInfo.eventTitle,
          memberEmail: paymentInfo.member.email,
          memberName: paymentInfo.member.name,
          memberImage: paymentInfo.member.image
        },

        success_url: `${process.env.CLIENT_DOMAIN}/event-payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/events/${paymentInfo.eventId}`
      })
      res.send({ url: session.url })


    })

    // ====================== CLUB PAYMENT ======================

    app.post('/api/club-payment-success', async (req, res) => {
      try {
        const { sessionId } = req.body
        if (!sessionId) return res.status(400).send({ message: "Session ID is required" })

        const session = await stripe.checkout.sessions.retrieve(sessionId)

        // 🔹 Get club
        const club = await clubsCollection.findOne({
          _id: new ObjectId(session.metadata.clubId)
        })
        if (!club) return res.status(400).send({ message: "Club not found" })

        // 🔹 Manager cannot join own club
        if (club.manager?.email === session.metadata.memberEmail) {
          return res.send({ message: "manager-cannot-join" })
        }

        // 🔹 Already member?
        const alreadyMember = await membersCollection.findOne({
          clubId: session.metadata.clubId,
          memberEmail: session.metadata.memberEmail
        })
        if (alreadyMember) return res.send({ message: "already-member" })

        // 🔹 Payment status
        if (session.payment_status !== 'paid') return res.send({ message: "payment-not-completed" })

        // 🔹 Duplicate payment
        const paymentExists = await paymentsCollection.findOne({
          transactionId: session.payment_intent
        })
        if (paymentExists) return res.send({ message: "payment-already-exists" })

        // ================= SAVE DATA =================
        const paymentInfo = {
          type: "membership",
          clubId: session.metadata.clubId,
          clubName: club.name,
          transactionId: session.payment_intent,
          memberEmail: session.metadata.memberEmail,
          memberName: session.metadata.memberName,
          memberImage: session.metadata.memberImage,
          price: session.amount_total / 100,
          status: 'paid',
          createdAt: new Date()
        }
        const paymentResult = await paymentsCollection.insertOne(paymentInfo)

        const memberInfo = {
          clubId: session.metadata.clubId,
          memberEmail: session.metadata.memberEmail,
          memberName: session.metadata.memberName,
          memberImage: session.metadata.memberImage,
          role: 'member',
          joinedAt: new Date()
        }
        const memberResult = await membersCollection.insertOne(memberInfo)

        res.send({
          message: "club-joined-successfully",
          transactionId: session.payment_intent,
          paymentId: paymentResult.insertedId,
          memberId: memberResult.insertedId
        })

      } catch (err) {
        console.error('Club payment success error:', err)
        res.status(500).send({ error: err.message })
      }
    })

    // ====================== EVENT PAYMENT ======================
    app.post('/api/event-payment-success', async (req, res) => {
      try {
        const { sessionId } = req.body
        if (!sessionId) return res.status(400).send({ message: "Session ID is required" })

        const session = await stripe.checkout.sessions.retrieve(sessionId)

        // 🔹 Payment status
        if (session.payment_status !== 'paid') return res.send({ message: "payment-not-completed" })

        // 🔹 Prevent duplicate registration
        const alreadyRegistered = await paymentsCollection.findOne({
          eventId: session.metadata.eventId,
          memberEmail: session.metadata.memberEmail,
          type: "registerPayment"
        })
        if (alreadyRegistered) return res.send({ message: "already-registered" })

        // 🔹 Prevent duplicate payment
        const paymentExists = await paymentsCollection.findOne({
          transactionId: session.payment_intent
        })
        if (paymentExists) return res.send({ message: "payment-already-exists" })

        // 🔹 Get event
        const event = await eventsCollection.findOne({
          _id: new ObjectId(session.metadata.eventId)
        })
        if (!event) return res.status(400).send({ message: "Event not found" })

        // 🔹 Manager cannot register own event
        if (event.manager?.email === session.metadata.memberEmail) {
          return res.send({ message: "manager-cannot-register" })
        }

        // 🔹 Check max attendees
        const currentCount = await paymentsCollection.countDocuments({
          eventId: session.metadata.eventId,
          type: "registerPayment"
        })
        if (event.maxAttendees && currentCount >= event.maxAttendees) {
          return res.send({ message: "event-full" })
        }

        // ================= SAVE DATA =================
        const paymentInfo = {
          type: "registerPayment",
          eventId: session.metadata.eventId,
          eventTitle: session.metadata.eventTitle,
          memberEmail: session.metadata.memberEmail,
          memberName: session.metadata.memberName,
          memberImage: session.metadata.memberImage,
          transactionId: session.payment_intent,
          price: session.amount_total / 100,
          status: "paid",
          createdAt: new Date()
        }
        const result = await paymentsCollection.insertOne(paymentInfo)

        res.send({
          message: "event-registration-successful",
          paymentId: result.insertedId,
          transactionId: session.payment_intent
        })

      } catch (err) {
        console.error('Event payment success error:', err)
        res.status(500).send({ error: err.message })
      }
    })

    app.get('/api/payments', verifyJWT, async (req, res) => {
      const type = req.query.type
      const query = { type }
      const result = await paymentsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray()
      res.send(result)

    })


    // ========================
    // event  api  get event for manager
    app.get('/api/events/manager', verifyJWT, async (req, res) => {

      const email = req.tokenEmail

      const Clubs = await clubsCollection.find({ email }).toArray()
      const clubIds = Clubs.map(c => c._id.toString())

      const events = await eventsCollection
        .find({ clubId: { $in: clubIds } })
        .sort({ eventDate: -1 })
        .toArray()

      res.send(events)

    })

    // get event 
    app.get('/api/events', async (req, res) => {
      const result = await eventsCollection.find().toArray()
      res.send(result)
    })

    app.get('/api/club-events', verifyJWT, async (req, res) => {
      const { clubId } = req.query

      const query = clubId ? { clubId } : {}

      const result = await eventsCollection.find(query).toArray()

      res.send(result)
    })

    app.get('/api/club-members/:clubId', verifyJWT, async (req, res) => {
      try {
        const { clubId } = req.params

        const members = await membersCollection
          .find({ clubId })
          .toArray()

        res.send(members)
      } catch (error) {
        res.status(500).send({ message: 'Failed to get members' })
      }
    })


    // POST /events
    // Manager শুধুমাত্র নিজের club এর জন্য event create করতে পারবে
    app.post('/api/events', verifyJWT, verifyManager, async (req, res) => {
      const eventData = req.body

      const club = await clubsCollection.findOne({ _id: new ObjectId(eventData.clubId) })
      if (!club || club.manager?.email !== req.tokenEmail) {
        return res.status(403).send({ message: 'Not authorized to create event for this club' })
      }

      eventData.createdAt = new Date()
      const result = await eventsCollection.insertOne(eventData)
      res.send(result)

    })

    app.get('/api/events/:id', verifyJWT, async (req, res) => {
      const eventId = req.params.id
      const event = await eventsCollection.findOne({ _id: new ObjectId(eventId) })
      if (!event) return res.status(404).send({ message: 'Event not found' })
      res.send(event)

    })


    app.get('/api/manager-events/:email', verifyJWT, verifyManager, async (req, res) => {
      const email = req.tokenEmail
      const query = {
        'manager.email': email
      }
      const events = await eventsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray()
      res.send(events)
    })

    app.get('/api/manager-event-registrations/:email', verifyJWT, verifyManager, async (req, res) => {
      const email = req.tokenEmail
      const events = await eventsCollection
        .find({ "manager.email": email })
        .toArray()
      const eventIds = events.map(event => event._id.toString())
      const registrations = await paymentsCollection
        .find({
          eventId: { $in: eventIds },
          type: "registerPayment"
        })
        .toArray()
      res.send(registrations)
    })


    // member dashboard api 
    app.get("/api/member-clubs/:email", verifyJWT, async (req, res) => {
      const email = req.tokenEmail
      const clubs = await membersCollection
        .find({ memberEmail: email })
        .toArray()
      const clubIds = clubs.map(c => c.clubId)
      const clubDetails = await clubsCollection
        .find({ _id: { $in: clubIds.map(id => new ObjectId(id)) } })
        .toArray()
      res.send(clubDetails)
    })

    app.get("/api/member-events/:email", verifyJWT, async (req, res) => {
      const email = req.tokenEmail
      const type = req.query.type

      const memberClubs = await membersCollection
        .find({ memberEmail: email })
        .toArray()

      const clubIds = memberClubs.map(c => c.clubId)

      const filter = {
        clubId: { $in: clubIds }
      }

      if (type === "upcoming") {
        filter.eventDate = { $gte: new Date() }
      }

      const events = await eventsCollection
        .find(filter)
        .sort({ eventDate: 1 })
        .toArray()

      res.send(events)
    })

    app.get("/api/member-payments/:email", verifyJWT, async (req, res) => {
      const email = req.tokenEmail
      const payments = await paymentsCollection
        .find({ memberEmail: email, type: "registerPayment" })
        .sort({ createdAt: -1 })
        .toArray()
      res.send(payments)
    })


    // save or  update user data
    app.post('/api/users', async (req, res) => {
      const userdata = req.body

      userdata.created_At = new Date().toISOString()
      userdata.last_Login = new Date().toISOString()
      userdata.role = "member"
      const query = {
        email: userdata.email
      }

      const AlreadyExit = await usersCollection.findOne(query)
      if (AlreadyExit) {

        const result = await usersCollection.updateOne(query, {
          $set: {
            last_Login: new Date().toISOString()
          }
        })
        return res.send(result)
      }
      const result = await usersCollection.insertOne(userdata)
      res.send(result)
    })

    // user role get
    app.get('/api/user/role', verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail })
      res.send({ role: result?.role })
    })

    // save  became-manager request
    // user routes
    app.post('/api/became-manager', verifyJWT, async (req, res) => {
      const email = req.tokenEmail
      const alreadyExists = await managersCollection.findOne({ email })
      if (alreadyExists) return res.status(409).send({
        message: 'Already  Requested !!'
      })

      const result = await managersCollection.insertOne({ email })
      res.send(result)
    })

    app.post('/api/became-admin', verifyJWT, async (req, res) => {
      const email = req.tokenEmail
      const result = await adminsCollection.insertOne({ email })
      res.send(result)
    })

    // get all request for manager
    // admin routes
    app.get('/api/manager-requests', verifyJWT, verifyADMIN, async (req, res) => {
      const result = await managersCollection.find().toArray()
      res.send(result)
    })

    app.get('/api/admin-requests', verifyJWT, verifyADMIN, async (req, res) => {
      const result = await adminsCollection.find().toArray()
      res.send(result)
    })

    // ================== approve manager ================
    app.patch('/api/approve-manager/:id', async (req, res) => {
      const id = req.params.id

      const request = await managersCollection.findOne({ _id: new ObjectId(id) })

      // user role update
      await usersCollection.updateOne(
        { email: request.email },
        { $set: { role: 'manager' } }
      )

      // delete request
      await managersCollection.deleteOne({ _id: new ObjectId(id) })

      res.send({ success: true })
    })

    app.patch('/api/approve-admin/:id', async (req, res) => {
      const id = req.params.id

      const request = await adminsCollection.findOne({ _id: new ObjectId(id) })

      await usersCollection.updateOne(
        { email: request.email },
        { $set: { role: 'admin' } }
      )

      await adminsCollection.deleteOne({ _id: new ObjectId(id) })

      res.send({ success: true })
    })

    // ======================== reject manager ====================
    app.delete('/api/reject-manager/:id', async (req, res) => {
      const id = req.params.id
      await managersCollection.deleteOne({ _id: new ObjectId(id) })
      res.send({ success: true })
    })

    app.delete('/api/reject-admin/:id', async (req, res) => {
      const id = req.params.id
      await adminsCollection.deleteOne({ _id: new ObjectId(id) })
      res.send({ success: true })
    })



    // get all users for admin
    // admin routes
    app.get('/api/users-for-admin', verifyJWT, verifyADMIN, async (req, res) => {
      const adminEmail = req.tokenEmail
      const result = await usersCollection.find({
        email: {
          $ne: adminEmail
        }
      }).toArray()
      res.send(result)
    })


    // update user role
    app.patch('/api/update-role', verifyJWT, verifyADMIN, async (req, res) => {
      try {
        const { email, role } = req.body

        // Role update in usersCollection
        const result = await usersCollection.updateOne(
          { email },
          { $set: { role } }
        )

        if (role === 'manager') {
          const exists = await managersCollection.findOne({ email })
          if (!exists) {
            const user = await usersCollection.findOne({ email })
            await managersCollection.insertOne({
              email,
              name: user?.name || '',
              image: user?.image || '',
              role: 'manager',
              assignedAt: new Date().toISOString(),
            })
          }
        } else {
          await managersCollection.deleteOne({ email })
        }

        res.send({
          success: true,
          modifiedCount: result.modifiedCount,
        })
      } catch (err) {
        res.status(500).send({ message: err.message })
      }
    })

    // post / create club
    app.post('/api/clubs', verifyJWT, async (req, res) => {
      const clubData = req.body
      const result = await clubsCollection.insertOne(clubData)
      res.send(result)
    })


    // get all clubs api
    app.get('/api/clubs', async (req, res) => {
      const result = await clubsCollection.find({ status: "approved" }).toArray()
      res.send(result)
    })



    // club api    club details
    app.get('/api/clubs/:id', verifyJWT, async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const club = await clubsCollection.findOne(query)
      res.send(club)
    })

    // ==================== Manager Api ==============================
    // get manager clubs
    app.get('/api/manager-clubs/:email', verifyJWT, verifyManager, async (req, res) => {
      const email = req.tokenEmail

      const result = await clubsCollection.find({
        "manager.email": email // 🔥 important
      }).toArray()

      res.send(result)
    })

    // get members
    app.get('/api/manager-members/:email', verifyJWT, verifyManager, async (req, res) => {
      const email = req.tokenEmail
      const managerClubs = await clubsCollection
        .find({ "manager.email": email })
        .toArray()
      const clubIds = managerClubs.map(club => club._id.toString())
      const members = await membersCollection
        .find({ clubId: { $in: clubIds } })
        .toArray()
      res.send(members)
    })



    // ======================================
    app.get('/api/admin/clubs', verifyJWT, async (req, res) => {
      const clubs = await clubsCollection.find().toArray()
      res.send(clubs)
    })


    // ============================= Status =============
    // club status update -> approve
    app.patch('/api/admin/clubs/approve/:id', verifyJWT, verifyADMIN, async (req, res) => {
      const id = req.params.id

      const result = await clubsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { status: "approved" }
        }
      )
      res.send(result)
    })

    // club status update ->reject
    app.patch('/api/admin/clubs/reject/:id', verifyJWT, verifyADMIN, async (req, res) => {
      const id = req.params.id
      const result = await clubsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { status: "rejected" }
        }
      )
      res.send(result)
    })



    // ======================= Statistics ==============================

    // statistics for admin
    app.get('/api/admin-stats', verifyJWT, verifyADMIN, async (req, res) => {

      const totalUsers = await usersCollection.estimatedDocumentCount()
      const totalClubs = await clubsCollection.estimatedDocumentCount()

      const pendingClubs = await clubsCollection.countDocuments({ status: "pending" })
      const approvedClubs = await clubsCollection.countDocuments({ status: "approved" })

      const totalEvents = await eventsCollection.estimatedDocumentCount()

      const payments = await paymentsCollection.find().toArray()
      const totalRevenue = payments.reduce((sum, p) => sum + (p.price || 0), 0)

      res.send({
        totalUsers,
        totalClubs,
        pendingClubs,
        approvedClubs,
        totalEvents,
        totalRevenue
      })
    })

    // manager statistics
    app.get('/api/manager-stats/:email', verifyJWT, verifyManager, async (req, res) => {

      const email = req.tokenEmail

      // my clubs
      const myClubs = await clubsCollection.find({
        "manager.email": email
      }).toArray()

      const clubIds = myClubs.map(c => c._id.toString())

      // members count
      const totalMembers = await membersCollection.countDocuments({
        clubId: { $in: clubIds }
      })

      // events
      const myEvents = await eventsCollection.find({
        "manager.email": email
      }).toArray()

      const eventIds = myEvents.map(e => e._id.toString())

      // registrations
      const totalRegistrations = await paymentsCollection.countDocuments({
        type: "registerPayment",
        eventId: { $in: eventIds }
      })

      // earnings
      const payments = await paymentsCollection.find({
        type: "event",
        eventId: { $in: eventIds }
      }).toArray()

      const totalEarnings = payments.reduce((sum, p) => sum + (p.price || 0), 0)

      res.send({
        totalClubs: myClubs.length,
        totalEvents: myEvents.length,
        totalMembers,
        totalRegistrations,
        totalEarnings
      })
    })

    // Member statistics
    app.get('/api/member-stats/:email', verifyJWT, async (req, res) => {

      const email = req.tokenEmail

      const joinedClubs = await membersCollection.countDocuments({
        memberEmail: email
      })

      const payments = await paymentsCollection.find({
        memberEmail: email
      }).toArray()

      const totalPayments = payments.length
      const totalSpent = payments.reduce((sum, p) => sum + (p.price || 0), 0)

      const registeredEvents = await paymentsCollection.countDocuments({
        memberEmail: email,
        type: "registerPayment"
      })

      res.send({
        joinedClubs,
        registeredEvents,
        totalPayments,
        totalSpent
      })
    })



    // ================= check membership or registration ==============
    // check member
    app.get('/api/is-member', verifyJWT, async (req, res) => {
      const { email, clubId } = req.query
      const member = await membersCollection.findOne({
        memberEmail: email,
        clubId
      })
      res.send(!!member)
    })
    // check registration
    app.get('/api/is-registered', verifyJWT, async (req, res) => {
      const { email, eventId } = req.query
      const reg = await paymentsCollection.findOne({
        memberEmail: email,
        eventId,
        type: "registerPayment"
      })
      res.send(!!reg)
    })


    // =============================== Count =========================
    // count event registrations
    app.get('/api/event-registration-count/:eventId', verifyJWT, async (req, res) => {
      const eventId = req.params.eventId
      const count = await paymentsCollection.countDocuments({
        eventId: eventId,
        type: "registerPayment"
      })
      res.send({ count })
    })
    // club member join count
    app.get('/api/club-member-count/:clubId', verifyJWT, async (req, res) => {
      const clubId = req.params.clubId

      const count = await membersCollection.countDocuments({
        clubId: clubId
      })

      res.send({ count })
    })

    // ===================================update=============================
    //  update Club
    app.put("/api/club-update/:id", verifyJWT, async (req, res) => {
      try {
        const { id } = req.params
        const updateData = req.body

        const club = await clubsCollection.findOne({
          _id: new ObjectId(id),
        })

        if (!club) {
          return res.status(404).send({ message: "Club not found" })
        }
        if (club.manager?.email !== req.user?.email) {
          return res.status(403).send({ message: "Forbidden" })
        }
        delete updateData.manager
        const result = await clubsCollection.updateOne(
          { _id: club._id },
          { $set: updateData }
        )

        res.send({
          success: true,
          message: "Club updated successfully",
          result,
        })
      } catch (error) {
        console.error(error)
        res.status(500).send({
          message: "Internal server error",
        })
      }
    })
    // Update event
    app.put("/api/events-update/:id", verifyJWT, async (req, res) => {
      try {
        const { id } = req.params
        const Data = req.body

        const event = await eventsCollection.findOne({
          _id: new ObjectId(id)
        })

        if (!event) {
          return res.status(404).send({ message: "Event not found" })
        }

        if (event.manager?.email !== req.user?.email) {
          return res.status(403).send({ message: "Forbidden" })
        }

        const result = await eventsCollection.updateOne(
          { _id: event._id },
          { $set: Data }
        )

        res.send({
          success: true,
          message: "Event updated successfully",
          result
        })
      } catch (error) {
        console.error(error)
        res.status(500).send({
          message: "Internal server error",
        })
      }
    })



    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )


  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir)

app.get('/api/', (req, res) => {
  res.send('Hello from Server..')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})

module.exports = app