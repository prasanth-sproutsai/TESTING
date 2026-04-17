/**
 * Jenkins: install dependencies, inject secrets as .env, run outreach test (dry run by default).
 *
 * Safety: OUTREACH_ALLOW_REAL_SEND is set from the job parameter below. Jenkins injects it before
 * Node starts; dotenv does not override existing variables, so this wins over any value in the
 * secret .env file — real sends cannot be turned on by a credential file alone.
 *
 * Prerequisites:
 * - Node.js tool in Jenkins (adjust name "nodejs-20" under Global Tool Configuration).
 * - Secret file credential ID "outreach-test-env" (or change credentialsId).
 *
 * Downstream jobs can archive copy outreach-flow-result.json from artifacts.
 */
pipeline {
  agent any

  tools {
    // Match Jenkins → Global Tool Configuration → NodeJS installations.
    nodejs "nodejs-20"
  }

  parameters {
    booleanParam(
      name: "ALLOW_REAL_OUTREACH_SEND",
      defaultValue: false,
      description: "Dangerous: allows OUTREACH_ALLOW_REAL_SEND=1 so APIs may email candidates. Leave unchecked for dry run."
    )
  }

  environment {
    // Only "1" when the boolean parameter is explicitly true (first build / null → dry run).
    OUTREACH_ALLOW_REAL_SEND = "${params.ALLOW_REAL_OUTREACH_SEND == true ? '1' : '0'}"
  }

  options {
    timestamps()
    disableConcurrentBuilds()
  }

  stages {
    stage("Checkout") {
      steps {
        checkout scm
      }
    }

    stage("Install dependencies") {
      steps {
        sh "npm ci"
      }
    }

    stage("Outreach automation") {
      steps {
        // Copy secrets to .env; OUTREACH_ALLOW_REAL_SEND still comes from Jenkins environment above.
        withCredentials([file(credentialsId: "outreach-test-env", variable: "OUTREACH_ENV_FILE")]) {
          sh "cp \"\$OUTREACH_ENV_FILE\" .env"
        }
        sh '''
          set -e
          echo "OUTREACH_ALLOW_REAL_SEND=${OUTREACH_ALLOW_REAL_SEND} (0=dry run, 1=live outreach APIs)"
          npm run outreach:test
        '''
      }
    }
  }

  post {
    always {
      archiveArtifacts artifacts: "outreach-flow-result.json, logs/outreach-test.log", allowEmptyArchive: true
    }
    failure {
      echo "Check archived logs and outreach-flow-result.json for error details."
    }
  }
}
