# ACM Online Judge CLI Helper

This is a simple script to help you submit code to ACM Class Online Judge right in your terminal, within a single command.

## Installation

`acmoj` runs on [Node][node]. You need to install that first.

```bash
sudo apt install nodejs # if you haven't yet
sudo npm i acmoj -g
```

[node]: https://nodejs.org/

## Signing in

Run `acmoj login` to sign in, `acmoj logout` to sign out. `acmoj login -r` (or `--remember`) will save your password on local disk, so you will not need to enter the password again after the session has expired.

## Submitting C++ files

`acmoj submit <problemId> [sourceFile]`. If `sourceFile` is omitted, for example, `acmoj submit 1000`, then it would try to find a file in these locations:

- `1000.hpp`
- `src/1000.hpp`
- `1000.h`
- `src/1000.h`
- `1000.cpp`
- `src/1000.cpp`
- `main.cpp`

## Submitting git repositories

First configure the problem ID with `acmoj git <problemId>`. This command will create a `.acmojrc` file in the root directory of your git repository containing the problem ID.

When you are ready to submit, run `acmoj submit` with no additional parameters.
