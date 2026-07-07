# sql-to-postgrest-api

This project dockerizes a Node.js server that utilizes Supabase [sql-to-rest](https://github.com/supabase-community/sql-to-rest) library to convert SQL statements into a format compatible for [PostgRest](https://docs.postgrest.org/en/v14/), and can either directly stream the result back to you, or just return the conversion.

## How to use the API

Prod URL: <https://sql-to-postgrest-api.citygeo.phila.city>
Dev URL: <https://dev-sql-to-postgrest-api.citygeo.phila.city>

Navigating here will redirect you to the Swagger UI

## AI Disclosure

This project was moderately assisted by AI due to the simple nature of it (just spinning up a minimal server that utilizes the [sql-to-rest](https://github.com/supabase-community/sql-to-rest) library), as well as the forced requirement of using Node.js
